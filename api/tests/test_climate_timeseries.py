import pytest

import extract_climate_timeseries as ect


def test_unknown_variable_is_rejected_before_any_query(monkeypatch):
    monkeypatch.setattr(ect, "_get_ch_client", lambda: pytest.fail("queried the database"))
    with pytest.raises(ValueError):
        ect.extract_climate_timeseries(49.0, -123.3, "temperature_mean), (SELECT 1", 0.5,
                                       "2024-01-01", "2024-01-31")
