from datetime import datetime

import pytest

import obs_area


class FakeResult:
    def __init__(self, rows):
        self.result_rows = rows
        self.first_row = rows[0] if rows else None


class FakeClient:
    """Answers each of obs_area's queries by the table it reads, and records them."""

    def __init__(self, tables):
        self.tables = tables
        self.queries = []

    def query(self, query, parameters=None):
        q = " ".join(query.lower().split())
        self.queries.append((q, parameters))
        for key, rows in self.tables.items():
            if key in q:
                return FakeResult(rows)
        return FakeResult([])

    def close(self):
        pass


SENSOR = "7ec78034-b369-43c5-9261-e275eab566c4"


def test_rebin_weights_means_by_count():
    rows = [("a", datetime(2024, 1, 1), 10.0, 9.0, 11.0, 3, 50.0),
            ("a", datetime(2024, 1, 20), 20.0, 19.0, 21.0, 1, 54.0)]
    [(p, b, mean, lo, hi, n, depth)] = obs_area._rebin(rows, "month")
    assert (p, b, n, lo, hi) == ("a", datetime(2024, 1, 1), 4, 9.0, 21.0)
    assert mean == pytest.approx(12.5)
    assert depth == pytest.approx(51.0)


def test_week_bins_start_on_monday():
    assert obs_area._bin_start(datetime(2024, 1, 7, 15), "week") == datetime(2024, 1, 1)


def test_only_listed_sources_are_read(monkeypatch):
    client = FakeClient({})
    monkeypatch.setattr(obs_area, "get_ch_client", lambda: client)
    out = obs_area.obs_area("temperature", 49.0, -123.4, 5, 0, 100)
    assert client.queries == []
    assert out["platforms"] == [] and out["points"]["time"] == []


def test_sensor_depth_uses_catalog_depth_for_fixed_sensors(monkeypatch):
    client = FakeClient({
        "from sensors final": [(SENSOR, "IOS SOGS 150 m", 49.03, -123.42, 150.0, "DFO IOS", 1200.0)],
        "from sensor_timeseries": [(SENSOR, datetime(2008, 10, 22), 9.1, 9.0, 9.2, 24, 150.0)],
    })
    monkeypatch.setattr(obs_area, "get_ch_client", lambda: client)
    out = obs_area.obs_area("temperature", 49.03, -123.42, 5, 100, 200, sensor_ids=[SENSOR, "not-a-uuid"])
    series_q, params = next(q for q in client.queries if "from sensor_timeseries" in q[0])
    # Fixed-depth rows are stored at depth 0: the depth range must test the catalog depth.
    assert "if(transform(" in series_q and params["sdep"] == [150.0]
    assert next(p for q, p in client.queries if "from sensors final" in q)["ids"] == [SENSOR]
    assert out["platforms"][0]["distanceKm"] == 1.2
    assert out["points"]["value"] == [9.1] and out["points"]["platform"] == [0]


def test_casts_are_averaged_over_the_depth_range(monkeypatch):
    client = FakeClient({
        "from ship_casts final": [("c1", "ctd", datetime(2020, 5, 1, 12), 49.0, -123.4, "2020-01", 300.0)],
        "from ship_cast_values": [("c1", 9.5, 9.0, 10.0, 12, 60.0)],
    })
    monkeypatch.setattr(obs_area, "get_ch_client", lambda: client)
    out = obs_area.obs_area("temperature", 49.0, -123.4, 5, 0, 120, casts=True, diel="night")
    assert out["platforms"][0]["type"] == "ctd"
    assert out["points"]["time"] == ["2020-05-01T12:00:00Z"]
    assert out["castsTotal"] == 1 and not out["castsTruncated"]
    casts_q = next(q for q, _ in client.queries if "from ship_casts final" in q)
    assert "and not (sin(radians(latitude))" in casts_q


@pytest.mark.parametrize("kw", [
    {"radius_km": 0}, {"radius_km": 500}, {"depth_min": 50, "depth_max": 10},
    {"diel": "dusk"}, {"bin": "decade"}, {"variable": "nope"},
])
def test_bad_boxes_are_rejected(kw):
    args = {"variable": "temperature", "lat": 49.0, "lon": -123.4, "radius_km": 5, "depth_min": 0, "depth_max": 100}
    args.update(kw)
    with pytest.raises(ValueError):
        obs_area.obs_area(**args)


@pytest.mark.parametrize("unit", ["week", "month", "year"])
def test_wide_bins_are_datetimes(unit):
    # ClickHouse's toStartOfWeek/Month/Year return Dates, which don't sort
    # against the casts' datetimes.
    assert obs_area._BIN_SQL[unit].startswith("toDateTime(")


def test_gliders_carry_sampled_fixes(monkeypatch):
    client = FakeClient({
        "grouparraysample": [("g1", [(-134.2, 49.2, 50.0), (-134.21, 49.21, 120.0)])],
        "from glider_deployments final": [("g1",)],
        "from glider_profiles": [("g1", datetime(2021, 2, 1), 7.1, 6.9, 7.3, 40, 80.0)],
    })
    monkeypatch.setattr(obs_area, "get_ch_client", lambda: client)
    out = obs_area.obs_area("temperature", 49.2, -134.2, 30, 0, 500, glider_ids=["g1"], bin="day")
    assert out["platforms"][0]["samples"] == [[-134.2, 49.2, 50.0], [-134.21, 49.21, 120.0]]


def test_argo_floats_read_their_own_tables_and_skip_the_glider_bbox(monkeypatch):
    client = FakeClient({
        "grouparraysample": [("argo-4902585", [(-134.5, 53.0, 10.0)])],
        "from argo_profile_values": [("argo-4902585", datetime(2024, 3, 1), 7.1, 6.9, 7.3, 12, 40.0)],
    })
    monkeypatch.setattr(obs_area, "get_ch_client", lambda: client)
    out = obs_area.obs_area("temperature", 53.0, -134.5, 100, 0, 100, glider_ids=["argo-4902585"], bin="day")
    assert [(p["id"], p["type"]) for p in out["platforms"]] == [("argo-4902585", "argo")]
    assert not any("glider_deployments" in q or "from glider_profiles" in q for q, _ in client.queries)
    assert all(p["g"] == ["argo-4902585"] for q, p in client.queries if "argo_profile_values" in q)
