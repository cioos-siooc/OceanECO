from datetime import datetime, timezone

import ios_casts_to_ch as ios

CANDIDATES = {k: v for k, v in ios.CANDIDATES.items()}


def _row(**kw):
    base = {"profile": "2024-002-0001", "mission_id": "2024-002", "geographic_area": "Juan-de-Fuca",
            "time": "2024-01-25T00:21:56Z", "latitude": "48.6", "longitude": "-123.5", "depth": "1.0"}
    return {**base, **kw}


def test_first_candidate_with_a_value_wins_and_is_converted():
    rows = [_row(sea_water_temperature="NaN", TEMPST01="8.5", DOXYZZ01="5.0")]
    casts, values = ios.parse_rows(rows, "IOS_CTD_Profiles", CANDIDATES)
    got = {v[1]: v[3] for v in values}
    assert got["temperature"] == 8.5
    assert abs(got["dissolved_oxygen"] - 5.0 * 44.66) < 1e-9


def test_out_of_range_values_are_dropped_not_replaced_by_a_fallback():
    rows = [_row(sea_water_temperature="99", TEMPST01="8.5")]
    _, values = ios.parse_rows(rows, "IOS_CTD_Profiles", CANDIDATES)
    assert not [v for v in values if v[1] == "temperature"]


def test_cast_metadata_is_utc_and_summarises_values():
    rows = [_row(depth="1.0", sea_water_salinity="31"),
            _row(depth="1.0", sea_water_practical_salinity="31.0"),
            _row(depth="40.0", sea_water_practical_salinity="32.0")]
    casts, values = ios.parse_rows(rows, "IOS_CTD_Profiles", CANDIDATES)
    assert len(casts) == 1
    c = casts[0]
    assert c["time"] == datetime(2024, 1, 25, 0, 21, 56, tzinfo=timezone.utc)
    assert c["cast_id"] == "ctd/2024-002-0001"
    assert c["kind"] == "ctd" and c["max_depth"] == 40.0 and c["variables"] == ["salinity"]
    assert c["geographic_area"] == "Juan de Fuca"


def test_casts_without_any_value_are_left_out():
    casts, values = ios.parse_rows([_row()], "IOS_BOT_Profiles", CANDIDATES)
    assert casts == [] and values == []


def test_months_cover_the_range_inclusively():
    first = datetime(2023, 11, 15, tzinfo=timezone.utc)
    last = datetime(2024, 1, 2, tzinfo=timezone.utc)
    starts = [s.strftime("%Y-%m") for s, _ in ios.months(first, last)]
    assert starts == ["2023-11", "2023-12", "2024-01"]


def test_depth_falls_back_to_pressure():
    rows = [_row(depth="NaN", PRESPR01="100", sea_water_practical_salinity="31")]
    _, values = ios.parse_rows(rows, "IOS_BOT_Profiles", CANDIDATES)
    assert len(values) == 1 and 98 < values[0][2] < 100
