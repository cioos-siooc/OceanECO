"""Which months each sensor has data in, for the observation-period filter.

The map keeps a sensor on screen when it has data in a month the filter
matches (front/app/utils/obsFilter.ts), so the frontend needs each sensor's
months, not its rows. Month granularity is coarse enough to stay small
(~600 sensors x a few hundred months) and fine enough for calendar-month and
season filters; a day-of-year window is matched against the months it touches.
"""
from __future__ import annotations

from cachetools import TTLCache, cached

from modules.clickhouse_helpers import get_ch_client


# Ingestion is hourly; a new month showing up an hour late doesn't matter.
@cached(TTLCache(maxsize=1, ttl=3600))
def sensor_coverage() -> dict[str, list[int]]:
    """sensor id -> sorted YYYYMM months with at least one row."""
    client = get_ch_client()
    try:
        rows = client.query(
            "SELECT sensor_id, groupArray(m) FROM ("
            " SELECT sensor_id, toYYYYMM(time) AS m FROM sensor_timeseries"
            " GROUP BY sensor_id, m ORDER BY m"
            ") GROUP BY sensor_id"
        ).result_rows
    finally:
        client.close()
    return {str(sid): [int(m) for m in months] for sid, months in rows}
