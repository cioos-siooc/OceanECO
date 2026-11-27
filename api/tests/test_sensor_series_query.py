import json

from extractSensorTimeseries import series_query, source_rank_sql


class FakeClient:
    def __init__(self, device_config):
        self.device_config = device_config

    def query(self, q):
        class R:
            result_rows = [(json.dumps(self.device_config),)]
        return R


CRIP = {"locationCode": "CRIP", "sources": {"temperature": [
    {"locationCode": "CRIP.C1", "deviceCategoryCode": "CTD", "sensorCategoryCode": "temperature"},
    {"locationCode": "CRIP", "deviceCategoryCode": "WETLABS_WQM", "sensorCategoryCode": "temperature"},
]}}


def test_rank_follows_catalog_order_and_puts_unlisted_last():
    rank = source_rank_sql(FakeClient(CRIP), "id", "temperature")
    assert rank == ("if(indexOf(['CRIP.C1/CTD', 'CRIP/WETLABS_WQM'], source) = 0, 3, "
                    "indexOf(['CRIP.C1/CTD', 'CRIP/WETLABS_WQM'], source))")


def test_single_source_needs_no_rank():
    assert source_rank_sql(FakeClient({}), "id", "temperature") == "0"
    assert source_rank_sql(FakeClient(CRIP), "id", "salinity") == "0"


def test_merged_query_takes_one_value_per_key():
    q = series_query(FakeClient(CRIP), "id", "temperature", None, "x = 1", keys="time", columns="time, value")
    assert "argMin(value, if(indexOf(" in q and "GROUP BY time" in q


def test_instrument_query_filters_to_that_source():
    q = series_query(FakeClient(CRIP), "id", "temperature", "CRIP.C1/CTD", "x = 1", keys="time", columns="time, value")
    assert "source = {inst:String}" in q and "argMin" not in q


# ── Display-time merges (comma-joined ids) ─────────────────────────────────────

from datetime import datetime

import extractSensorTimeseries as est
from extractSensorTimeseries import id_filter, is_merged, sensor_ids


def test_sensor_ids_split_and_sanitise():
    assert sensor_ids("a-1") == ["a-1"]
    assert sensor_ids("a-1, b-2,") == ["a-1", "b-2"]
    assert sensor_ids("a'; DROP--,b") == ["aDROP--", "b"]


def test_id_filter_single_and_merged():
    assert id_filter("a-1") == "sensor_id = 'a-1'"
    assert id_filter("a-1,b-2", "id") == "id IN ('a-1', 'b-2')"
    assert is_merged("a,b") and not is_merged("a")


def test_merged_rank_is_constant():
    assert source_rank_sql(FakeClient(CRIP), "a,b", "temperature") == "0"


class RowsClient:
    def __init__(self, rows):
        self.rows, self.queries = rows, []

    def query(self, q, parameters=None):
        self.queries.append(q)
        rows = self.rows

        class R:
            result_rows = rows
        return R


def test_merged_series_averages_overlaps_and_reports_mean_depth(monkeypatch):
    client = RowsClient([(datetime(2022, 1, 1, 0), 9.0, 50.0), (datetime(2022, 1, 1, 1), 9.5, 52.0)])
    monkeypatch.setattr(est, "get_ch_client", lambda: client)
    out = est.extract_sensor_timeseries("a,b", "temperature", "2022-01-01", "2022-01-02", depth=51.0)
    assert out == {"time": ["2022-01-01T00:00:00", "2022-01-01T01:00:00"], "value": [9.0, 9.5], "depth": 51.0}
    q = client.queries[0]
    assert "sensor_id IN ('a', 'b')" in q and "avg(value)" in q and "GROUP BY time" in q


def test_merged_series_without_depth_omits_it(monkeypatch):
    client = RowsClient([(datetime(2022, 1, 1, 0), 9.0, 50.0)])
    monkeypatch.setattr(est, "get_ch_client", lambda: client)
    out = est.extract_sensor_timeseries("a,b", "temperature", "2022-01-01", "2022-01-02")
    assert "depth" not in out and out["value"] == [9.0]


# ── Request strings never reach the SQL text ──────────────────────────────────

import pytest

HOSTILE = "x\\' OR 1=1 --"  # a backslash-escaped quote closes a ''-doubled string


@pytest.mark.parametrize("depth", [None, 5.0])
def test_request_strings_are_bound_or_stripped(monkeypatch, depth):
    seen = []

    class Recorder:
        def query(self, q, parameters=None):
            seen.append((q, parameters or {}))
            class R:
                result_rows = []
            return R

    monkeypatch.setattr(est, "get_ch_client", lambda: Recorder())
    with pytest.raises(FileNotFoundError):
        # A trailing backslash in the id would escape its closing quote.
        est.extract_sensor_timeseries(
            "abc\\", HOSTILE, "2024-01-01", "2024-01-02", depth=depth, instrument=HOSTILE)
    assert seen and all("OR 1=1" not in q and "\\" not in q for q, _ in seen)
    assert any(p.get("v") == HOSTILE and p.get("inst") == HOSTILE for _, p in seen)
