from datetime import datetime

import pytest

import ship_casts
from extractTimeseries import OutsideDomainError


class FakeResult:
    def __init__(self, rows):
        self.result_rows = rows
        self.first_row = rows[0] if rows else None


class FakeClient:
    def __init__(self, meta=None, values=None, listing=None):
        self.meta, self.values, self.listing = meta or [], values or [], listing or []

    def query(self, query, parameters=None):
        q = " ".join(query.lower().split())
        if "from ship_cast_values" in q:
            return FakeResult(self.values)
        if "where cast_id =" in q:
            return FakeResult(self.meta)
        if "select count()" in q:
            return FakeResult([(len(self.listing),)])
        return FakeResult(self.listing)

    def close(self):
        pass


META = [("2024-002-0001", "IOS_CTD_Profiles", "ctd", "2024-002", datetime(2024, 1, 25, 0, 21, 56),
         48.659, -123.5, "Juan de Fuca", 120.0)]
VALUES = [("salinity", 1.0, 31.0), ("salinity", 2.0, 31.2), ("temperature", 1.0, 8.5)]


def test_profile_groups_values_by_variable(monkeypatch):
    monkeypatch.setattr(ship_casts, "get_ch_client", lambda: FakeClient(META, VALUES))
    out = ship_casts.cast_profile("2024-002-0001")
    assert out["cast"]["time"] == "2024-01-25T00:21:56Z"
    assert out["profiles"]["salinity"] == {"depth": [1.0, 2.0], "value": [31.0, 31.2]}
    assert out["model"] is None and out["modelError"] is None


def test_missing_cast_is_not_found(monkeypatch):
    monkeypatch.setattr(ship_casts, "get_ch_client", lambda: FakeClient())
    with pytest.raises(FileNotFoundError):
        ship_casts.cast_profile("nope")


def test_model_falls_back_from_hourly_to_daily(monkeypatch):
    calls = []

    def fake_profile(**kw):
        calls.append(kw["bin_mode"])
        if kw["bin_mode"] == "hourly":
            raise RuntimeError("no hour within tolerance")
        return [{"depth": 0.5, "value": 8.0}, {"depth": 1.5, "value": 8.1}]

    monkeypatch.setattr(ship_casts, "get_ch_client", lambda: FakeClient(META, VALUES))
    monkeypatch.setattr(ship_casts, "extract_profile", fake_profile)
    out = ship_casts.cast_profile("2024-002-0001", "SalishSeaCast", "temperature")
    assert calls == ["hourly", "daily"]
    assert out["model"] == {"source": "SalishSeaCast", "binMode": "daily", "depth": [0.5, 1.5], "value": [8.0, 8.1]}


def test_outside_domain_returns_null_model_with_reason(monkeypatch):
    def fake_profile(**kw):
        raise OutsideDomainError(lat=48.0, lon=-140.0, distance_km=900.0, max_distance_km=5.0)

    monkeypatch.setattr(ship_casts, "get_ch_client", lambda: FakeClient(META, VALUES))
    monkeypatch.setattr(ship_casts, "extract_profile", fake_profile)
    out = ship_casts.cast_profile("2024-002-0001", "SalishSeaCast", "temperature")
    assert out["model"] is None and out["modelError"]["code"]


def test_unmodelled_variable_skips_the_model(monkeypatch):
    monkeypatch.setattr(ship_casts, "get_ch_client", lambda: FakeClient(META, VALUES))
    monkeypatch.setattr(ship_casts, "extract_profile", lambda **kw: pytest.fail("model queried"))
    out = ship_casts.cast_profile("2024-002-0001", "SalishSeaCast", "nitrate")
    assert out["model"] is None and out["modelError"]["code"] == "not_modelled"


def test_listing_truncates_and_labels_observed_variables(monkeypatch):
    row = ("c", "bottle", datetime(2024, 1, 1), 48.0, -123.0, "m", "a", 50.0, ["nitrate"])
    monkeypatch.setattr(ship_casts, "MAX_CASTS", 2)
    monkeypatch.setattr(ship_casts, "get_ch_client", lambda: FakeClient(listing=[row] * 3))
    out = ship_casts.list_casts("2024-01-01", "2025-01-01")
    assert out["truncated"] and len(out["casts"]) == 2 and out["total"] == 3
    assert out["variables"]["nitrate"]["modelled"] is False
    assert out["variables"]["temperature"]["modelled"] is True


def test_listing_rejects_an_empty_period():
    with pytest.raises(ValueError):
        ship_casts.list_casts("2024-02-01", "2024-01-01")


def test_a_failing_model_read_leaves_the_cast(monkeypatch):
    def fake_profile(**kw):
        raise KeyError("grid table missing")

    monkeypatch.setattr(ship_casts, "get_ch_client", lambda: FakeClient(META, VALUES))
    monkeypatch.setattr(ship_casts, "extract_profile", fake_profile)
    out = ship_casts.cast_profile("2024-002-0001", "SalishSeaCast", "temperature")
    assert out["profiles"] and out["model"] is None and out["modelError"]["code"] == "model_unavailable"


def test_filter_sql_combines_range_months_and_day_of_year():
    where, params = ship_casts.cast_filter_sql("1990-01-01", None, [12, 1, 2, 1], 225, 15)
    assert "time >= {f:DateTime64(0)}" in where and "time <" not in where
    assert params["m"] == [1, 2, 12]
    assert params["c"] == 225 and params["h"] == 15


def test_filter_sql_without_a_filter_matches_everything():
    assert ship_casts.cast_filter_sql() == ("1", {})


@pytest.mark.parametrize("kw", [{"months": [13]}, {"doy": 400, "half_days": 5}, {"doy": 10}])
def test_filter_sql_rejects_bad_values(kw):
    with pytest.raises(ValueError):
        ship_casts.cast_filter_sql(**kw)
