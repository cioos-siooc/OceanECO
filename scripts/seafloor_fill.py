"""Turn the ETOPO 2022 subset into the seafloor tiles' fill GeoTIFF (step 6 of
seafloor_tiles.sh): everything the NRCan DEM covers, land included, is blanked
so the coarse ETOPO coastline never paints over the DEM's.

    seafloor_fill.py <etopo.nc> <dem.tiff> <out.tiff>

A fill cell is blanked only when the DEM covers all of it; cells straddling the
DEM's edge keep ETOPO, and the tiler's "existing pixels win" composite leaves
the DEM's own pixels on top there, so the seam has no holes.
"""
import sys

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.warp import Resampling, reproject

etopo_nc, dem_tiff, out_tiff = sys.argv[1:4]

with rasterio.open(f'netcdf:{etopo_nc}:z') as src:
    z = src.read(1).astype(np.float32)
    transform = src.transform
    if src.nodata is not None:
        z[z == src.nodata] = np.nan

with rasterio.open(dem_tiff) as dem:
    covered = dem.read_masks(1) > 0  # valid DEM pixels, land and sea
    dem_crs, dem_transform = dem.crs, dem.transform

full = np.zeros(z.shape, dtype=np.uint8)
reproject(covered.astype(np.uint8), full,
          src_transform=dem_transform, src_crs=dem_crs, src_nodata=None,
          dst_transform=transform, dst_crs=CRS.from_epsg(4326), dst_nodata=None,
          resampling=Resampling.min)
z[full == 1] = np.nan

profile = dict(driver='GTiff', width=z.shape[1], height=z.shape[0], count=1, dtype='float32',
               crs=CRS.from_epsg(4326), transform=transform, nodata=np.nan,
               compress='deflate', predictor=3, tiled=True)
with rasterio.open(out_tiff, 'w', **profile) as dst:
    dst.write(z, 1)
print(f'{out_tiff}: {np.isfinite(z).mean():.0%} of the subset kept outside the DEM')
