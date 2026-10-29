from datetime import datetime, timezone

import netCDF4
import numpy as np

from cproof_to_ch import parse_grid_file, parse_index_url

BASE = "https://cproof.uvic.ca/gliderdata/deployments/./dfo-eva035/dfo-eva035-20260826/L0-gridfiles/"


def test_parse_index_url_variants():
    e = parse_index_url(BASE + "dfo-eva035-20260826_grid_delayed_adjusted.nc")
    assert e == {
        "url": BASE.replace("/./", "/") + "dfo-eva035-20260826_grid_delayed_adjusted.nc",
        "glider": "dfo-eva035",
        "deployment_id": "dfo-eva035-20260826",
        "variant": "delayed_adjusted",
    }
    assert parse_index_url(BASE + "dfo-eva035-20260826_grid.nc")["variant"] == "grid"
    assert parse_index_url("not a glider file") is None


def _write_grid(path):
    with netCDF4.Dataset(path, "w") as ds:
        ds.createDimension("depth", 3)
        ds.createDimension("time", 3)
        ds.createVariable("depth", "f8", ("depth",))[:] = [5, 15, 25]
        t = ds.createVariable("time", "f8", ("time",))
        t.units = "seconds since 1970-01-01T00:00:00+00:00"
        t[:] = [1_790_000_000, 1_790_000_600, 1_790_001_200]
        # The middle profile's position is in radians, as in a few early files.
        ds.createVariable("latitude", "f8", ("time",))[:] = [48.7, 0.85, 48.8]
        ds.createVariable("longitude", "f8", ("time",))[:] = [-126.2, -2.2, -126.3]
        temp = ds.createVariable("temperature", "f8", ("depth", "time"), fill_value=np.nan)
        temp[:] = [[10.0, 10.0, 99.0], [9.0, 9.0, np.nan], [8.0, 8.0, 7.5]]
        ds.createVariable("oxygen_concentration", "f8", ("depth", "time"))[:] = np.full((3, 3), 250.0)
        ds.platform_type = "Slocum Glider"
        ds.deployment_station = "Tofino"


def test_parse_grid_file(tmp_path):
    path = tmp_path / "g.nc"
    _write_grid(str(path))
    rows, meta = parse_grid_file(str(path), "dep-1")

    temp = [r for r in rows if r[5] == "temperature"]
    # Profile 1 is dropped (bad position); 99 °C is outside the gross range; NaN is skipped.
    assert [(r[1], r[6], r[7]) for r in temp] == [(0, 5.0, 10.0), (0, 15.0, 9.0), (0, 25.0, 8.0), (2, 25.0, 7.5)]
    assert {r[5] for r in rows} == {"temperature", "dissolved_oxygen"}
    assert meta["profiles"] == 2
    assert meta["station"] == "Tofino"
    assert meta["start_time"] == datetime.fromtimestamp(1_790_000_000, timezone.utc).replace(tzinfo=None)
    assert (meta["lat_min"], meta["lat_max"]) == (48.7, 48.8)
