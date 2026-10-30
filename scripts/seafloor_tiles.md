# Seafloor tiles

The glider curtain's 3D seafloor reads value-packed depth tiles from the API:
`GET /seafloor/{z}/{x}/{y}.webp`. The API serves them from `SEAFLOOR_TILES_ROOT`, which defaults to `/opt/data/bathymetry/seafloor_tiles`. They are decoded in the browser by `front/composables/useSeafloorGrid.ts`.

`seafloor_tiles.sh` rebuilds the whole tile tree from the public NRCan DEM.

## Rebuild

```bash
scripts/seafloor_tiles.sh            # work dir defaults to data/bathymetry
```

**Requirements:**
- Docker, with the `ghcr.io/osgeo/gdal:ubuntu-full-latest` image (the same image `bathymetry.sh` uses).
- `scripts/.venv` (`uv sync` in `scripts/`).
- About 40 GB free during the first run.

**Run time:** about 1–2 hours on the first run, most of it the DEM download and warp. Each step whose output already exists is skipped, so after an interruption, rerun the script. The tile tree itself is always rebuilt from scratch.

**Output:** `data/bathymetry/seafloor_tiles/{z}/{x}/{y}.webp`. Copy that tree to `SEAFLOOR_TILES_ROOT` on each API host (prod and staging), for example:

```bash
rsync -a --delete data/bathymetry/seafloor_tiles/ <host>:/home/cioos/OA_data/bathymetry/seafloor_tiles/
```

Tiles are served with `immutable` caching. After replacing them, browsers keep old tiles until their cache expires, unless the path changes.

## Steps

| # | Step | Output (under `<work>/seafloor_src/`) |
|---|---|---|
| 1 | Download the NRCan DEM (`.gdb.zip`, 7.9 GB) | `canada_west_coast_DEM_original.gdb.zip` |
| 2 | Unzip | `canada_west_coast_DEM_original.gdb/` |
| 3 | `gdalwarp` the `WEST_COAST_DEM` layer to 50 m with `-r average`, in the GDAL Docker image | `dem/west_coast_DEM_50m.tiff` |
| 4 | `cnvMaster_RGBcoded.py` on the DEM | `<work>/seafloor_tiles/` |

The DEM ends at about −2767 m, so there is no seafloor beyond its extent (for example outer Line P toward Station P). A deeper global grid such as GEBCO could fill that gap: tile it after the DEM into the same tree. The tiler is additive, so it would fill only pixels the DEM leaves empty.

Step 3 warps to 50 m because zoom 10, the deepest the frontend uses, is about 50 m per pixel at these latitudes. Tiling the 10 m original directly would read about 30× more data for no visible gain.

## Encoding

This is the same scheme as the paused raster bathymetry layer (`bathymetry.md`, section 1), with a deeper base and fewer zooms:

| | |
|---|---|
| Value | `q = (elevation − MIN_ORG) / STEP`, packed big-endian into R, G, B |
| `MIN_ORG` | −11000 m (headroom for a deeper fill source; the paused layer's −3000 m would cut off anything below that) |
| `STEP` | 1 m |
| Alpha | 0 for land (elevation ≥ 0) and no data |
| Tiles | 512 px, lossless WebP, zooms 5–10 |

If you change `MIN_ORG`, `STEP`, the zooms or the tile size, change the matching constants in `useSeafloorGrid.ts` too.

## Sources and credits

- **NRCan, Canada West Coast Topo-Bathymetric DEM.** 10 m, land and sea, −2767 to +2465 m, NAD83 / BC Albers. Open Government Licence – Canada. Catalogue record: https://open.canada.ca/data/en/dataset/e6e11b99-f0cc-44f7-f5eb-3b995fb1637e. It is the same source as the bathymetry contours (`bathymetry.sh`).
