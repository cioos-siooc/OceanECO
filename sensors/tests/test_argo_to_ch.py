from datetime import datetime, timezone

import argo_to_ch as argo


def _core(**kw):
    base = {"platform_number": "4902568", "cycle_number": "12", "direction": "A", "data_mode": "R",
            "time": "2024-06-09T01:44:09Z", "latitude": "50.0", "longitude": "-145.0", "position_qc": "1",
            "date_update": "2024-06-10T00:00:00Z", "project_name": "Argo CANADA", "pi_name": "PI",
            "platform_type": "NAVIS_A", "pres": "100", "pres_qc": "1", "pres_adjusted": "NaN", "pres_adjusted_qc": " ",
            "temp": "8.0", "temp_qc": "1", "temp_adjusted": "NaN", "temp_adjusted_qc": " ",
            "psal": "32.5", "psal_qc": "1", "psal_adjusted": "NaN", "psal_adjusted_qc": " "}
    return {**base, **kw}


def _bgc(**kw):
    base = {"platform_number": "4902568", "cycle_number": "12", "direction": "A",
            "time": "2024-06-09T01:44:09Z", "latitude": "50.0", "longitude": "-145.0", "position_qc": "1",
            "date_update": "2025-01-01T00:00:00Z", "pres": "100", "pres_qc": "1", "pres_adjusted": "NaN",
            "pres_adjusted_qc": " ", "doxy_adjusted": "200", "doxy_adjusted_qc": "1",
            "nitrate_adjusted": "NaN", "nitrate_adjusted_qc": " ", "ph_in_situ_total_adjusted": "7.9",
            "ph_in_situ_total_adjusted_qc": "1", "chla_adjusted": "NaN", "chla_adjusted_qc": " "}
    return {**base, **kw}


def test_realtime_core_uses_raw_columns_and_merges_bgc():
    profiles, values = argo.parse_rows([_core()], [_bgc()])
    assert len(profiles) == 1
    p = profiles[0]
    assert p["profile_id"] == "4902568_012A" and p["data_mode"] == "R" and p["project"] == "Argo CANADA"
    assert p["time"] == datetime(2024, 6, 9, 1, 44, 9, tzinfo=timezone.utc)
    # The later of the two datasets' revisions.
    assert p["date_update"] == datetime(2025, 1, 1, tzinfo=timezone.utc)
    got = {v[1]: v[3] for v in values}
    assert got["temperature"] == 8.0 and got["salinity"] == 32.5 and got["ph_total"] == 7.9
    assert abs(got["dissolved_oxygen"] - 205.0) < 1e-9
    assert p["variables"] == ["dissolved_oxygen", "ph_total", "salinity", "temperature"]
    # 100 dbar at 50°N is ~99 m.
    assert all(98 < v[2] < 100 for v in values)


def test_delayed_mode_core_uses_adjusted_and_drops_bad_flags():
    row = _core(data_mode="D", pres_adjusted="100", pres_adjusted_qc="1",
                temp_adjusted="7.5", temp_adjusted_qc="1", psal_adjusted="33", psal_adjusted_qc="4")
    _, values = argo.parse_rows([row], [])
    assert [(v[1], v[3]) for v in values] == [("temperature", 7.5)]


def test_bgc_never_falls_back_to_raw_and_bad_positions_are_dropped():
    _, values = argo.parse_rows([], [_bgc(doxy_adjusted="NaN", doxy_adjusted_qc=" ", doxy="200", doxy_qc="1")])
    assert "dissolved_oxygen" not in {v[1] for v in values}
    profiles, _ = argo.parse_rows([_core(position_qc="4")], [])
    assert profiles == []


def test_interpolated_under_ice_positions_are_kept():
    profiles, _ = argo.parse_rows([_core(position_qc="8")], [])
    assert len(profiles) == 1


def test_only_new_or_revised_profiles_are_changed():
    t = datetime(2025, 1, 1, tzinfo=timezone.utc)
    profiles = [{"profile_id": "a", "date_update": t}, {"profile_id": "b", "date_update": t},
                {"profile_id": "c", "date_update": t}]
    stored = {"a": t, "b": datetime(2024, 1, 1, tzinfo=timezone.utc)}
    assert argo.changed(profiles, stored) == {"b", "c"}
