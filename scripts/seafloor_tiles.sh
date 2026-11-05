#!/usr/bin/env bash
# Build the seafloor depth tiles behind GET /seafloor/{z}/{x}/{y}.webp (the
# glider curtain's 3D seafloor) from scratch. See seafloor_tiles.md.
#
#   scripts/seafloor_tiles.sh [work_dir]     # default: data/bathymetry
#
# Every download/conversion step is skipped when its output already exists;
# the tile tree itself is always rebuilt.
set -euo pipefail

SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mkdir -p "${1:-$SCRIPTS/../data/bathymetry}" && cd "${1:-$SCRIPTS/../data/bathymetry}" && pwd)"
SRC="$WORK/seafloor_src"
OUT="$WORK/seafloor_tiles"
PY="$SCRIPTS/.venv/bin/python"
GDAL_IMAGE="ghcr.io/osgeo/gdal:ubuntu-full-latest"
DEM_URL="https://ftp.maps.canada.ca/pub/nrcan_rncan/Topography_Topographie/canada_west_coast_DEM-MNA_cote_ouest_canada/canada_west_coast_DEM_original.gdb.zip"
DEM_ZIP="$SRC/canada_west_coast_DEM_original.gdb.zip"
DEM_TIFF="$SRC/dem/west_coast_DEM_50m.tiff"
# ETOPO 2022 (15″, ~450 m) fills the deep water the DEM stops short of, over the
# C-PROOF glider tracks (146.6–123.5°W, 46.6–53.4°N in 2026-11) plus the
# frontend's 25% bbox padding around the widest (Line P) tracks. Widen it if a
# deployment flies outside, and delete the cached .nc to re-download.
FILL_W=-152 FILL_E=-122 FILL_S=45.5 FILL_N=54
FILL_URL="https://coastwatch.pfeg.noaa.gov/erddap/griddap/ETOPO_2022_v1_15s.nc?z%5B(${FILL_S}):1:(${FILL_N})%5D%5B(${FILL_W}):1:(${FILL_E})%5D"
FILL_NC="$SRC/etopo/ETOPO_2022_15s.nc"
FILL_TIFF="$SRC/etopo/fill/etopo_fill.tiff"

# Tile encoding and zooms: the frontend decoder (front/composables/useSeafloorGrid.ts) must match.
MIN_ORG=-11000
MIN_ZOOM=5
MAX_ZOOM=10

mkdir -p "$SRC/dem" "$SRC/etopo/fill"

echo "== 1/6 NRCan West Coast DEM (7.9 GB)"
if [ ! -f "$DEM_TIFF" ] && [ ! -d "$SRC/canada_west_coast_DEM_original.gdb" ]; then
    # The server drops long transfers: resume (-C -) on any error until complete.
    curl -fL -C - --retry 30 --retry-all-errors --retry-delay 10 -o "$DEM_ZIP" "$DEM_URL"
fi

echo "== 2/6 Unzip"
if [ ! -f "$DEM_TIFF" ] && [ ! -d "$SRC/canada_west_coast_DEM_original.gdb" ]; then
    unzip -q "$DEM_ZIP" -d "$SRC"
fi

echo "== 3/6 DEM → 50 m GeoTIFF (z10 is ~50 m/px; averaging here keeps tiling fast)"
if [ ! -f "$DEM_TIFF" ]; then
    GDB="$(cd "$SRC" && find . -maxdepth 2 -type d -name '*.gdb' | head -1)"
    docker run --rm --user "$(id -u):$(id -g)" -v "$SRC:/data" "$GDAL_IMAGE" \
        gdalwarp -tr 50 50 -r average -multi -wo NUM_THREADS=ALL_CPUS \
        -of GTiff -co COMPRESS=DEFLATE -co PREDICTOR=3 -co TILED=YES -co BIGTIFF=IF_SAFER \
        "OpenFileGDB:\"/data/${GDB#./}\":WEST_COAST_DEM" "/data/dem/$(basename "$DEM_TIFF")"
fi

echo "== 4/6 DEM tiles → $OUT"
rm -rf "$OUT"
"$PY" "$SCRIPTS/cnvMaster_RGBcoded.py" --tiff-dir "$SRC/dem" --pattern '*.tiff' --output-dir "$OUT" \
    --min-org "$MIN_ORG" --min-zoom "$MIN_ZOOM" --max-zoom "$MAX_ZOOM" --resampling average

echo "== 5/6 ETOPO 2022 subset (~60 MB)"
if [ ! -f "$FILL_NC" ]; then
    curl -fL --retry 5 --retry-delay 10 -o "$FILL_NC.part" "$FILL_URL" && mv "$FILL_NC.part" "$FILL_NC"
fi

echo "== 6/6 ETOPO fill → $OUT (only where the DEM has no data)"
"$PY" "$SCRIPTS/seafloor_fill.py" "$FILL_NC" "$DEM_TIFF" "$FILL_TIFF"
"$PY" "$SCRIPTS/cnvMaster_RGBcoded.py" --tiff-dir "$(dirname "$FILL_TIFF")" --pattern '*.tiff' --output-dir "$OUT" \
    --min-org "$MIN_ORG" --min-zoom "$MIN_ZOOM" --max-zoom "$MAX_ZOOM" --resampling bilinear

echo "Done: $(find "$OUT" -name '*.webp' | wc -l) tiles, $(du -sh "$OUT" | cut -f1). Copy $OUT to SEAFLOOR_TILES_ROOT on the API host."
