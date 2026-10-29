"""C-PROOF glider deployments, harvested by sensors/cproof_to_ch.py.

A deployment is a moving profiler: every profile carries its own fix, so its
data lives in `glider_profiles` rather than `sensor_timeseries`, and the map
draws a track instead of a marker.

`list_gliders()` feeds the map and the sensor list (one track point per
profile). `extract_glider_section()` returns one variable as a depth x profile
grid in the shape `depth/TimeDepthHeatmap.vue` takes, plus each profile's
time, position and along-track distance.
"""
from __future__ import annotations

import math

from modules.clickhouse_helpers import get_ch_client


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _iso(dt) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def list_gliders() -> list[dict]:
    client = get_ch_client()
    deployments = client.query("""
        SELECT deployment_id, glider, platform_type, summary, station,
               start_time, end_time, lat_min, lat_max, lon_min, lon_max,
               profiles, file_url, variant, active
        FROM glider_deployments FINAL
        WHERE profiles > 0
        ORDER BY start_time DESC
    """).result_rows

    # One fix per profile; any variable carries it, so take the cheapest.
    tracks: dict[str, list] = {}
    variables: dict[str, list[str]] = {}
    for dep, profile, lat, lon, t in client.query("""
        SELECT deployment_id, profile, any(latitude), any(longitude), any(time)
        FROM glider_profiles
        GROUP BY deployment_id, profile
        ORDER BY deployment_id, profile
    """).result_rows:
        tracks.setdefault(dep, []).append([round(lon, 5), round(lat, 5), _iso(t), int(profile)])
    for dep, var in client.query(
        "SELECT DISTINCT deployment_id, variable FROM glider_profiles"
    ).result_rows:
        variables.setdefault(dep, []).append(var)

    out = []
    for (dep, glider, platform, summary, station, start, end, lat0, lat1, lon0, lon1,
         profiles, url, variant, active) in deployments:
        track = tracks.get(dep, [])
        dist = sum(_haversine_km(a[1], a[0], b[1], b[0]) for a, b in zip(track, track[1:]))
        out.append({
            "id": dep,
            "glider": glider,
            "platformType": platform,
            "summary": summary,
            "station": station,
            "start": _iso(start),
            "end": _iso(end),
            "bbox": [lon0, lat0, lon1, lat1],
            "profiles": int(profiles),
            "distanceKm": round(dist, 1),
            "variables": sorted(variables.get(dep, [])),
            "fileUrl": url,
            "variant": variant,
            "active": bool(active),
            # [lon, lat, time, profile] per profile, in profile order.
            "track": track,
        })
    return out


def extract_glider_section(deployment_id: str, var: str) -> dict:
    """One variable of one deployment as a depth x profile grid.

    Response: { profiles: [int...], time: [iso...], lat: [...], lon: [...],
                distanceKm: [...], depths: [float...], values: [[float|null]] }
                — values is depths x profiles.
    """
    client = get_ch_client()
    rows = client.query(
        """
        SELECT profile, time, latitude, longitude, depth, value
        FROM glider_profiles
        WHERE deployment_id = {d:String} AND variable = {v:String}
        ORDER BY profile, depth
        """,
        parameters={"d": deployment_id, "v": var},
    ).result_rows
    if not rows:
        raise ValueError(f"No {var} data for glider deployment {deployment_id}")

    profiles = sorted({r[0] for r in rows})
    depths = sorted({float(r[4]) for r in rows})
    p_idx = {p: i for i, p in enumerate(profiles)}
    d_idx = {d: i for i, d in enumerate(depths)}
    values: list[list[float | None]] = [[None] * len(profiles) for _ in depths]
    meta: dict[int, tuple] = {}
    for profile, t, lat, lon, depth, value in rows:
        values[d_idx[float(depth)]][p_idx[profile]] = float(value)
        meta.setdefault(profile, (t, lat, lon))

    dist, total, prev = [], 0.0, None
    for p in profiles:
        _, lat, lon = meta[p]
        if prev is not None:
            total += _haversine_km(prev[0], prev[1], lat, lon)
        dist.append(round(total, 2))
        prev = (lat, lon)

    return {
        "deployment": deployment_id,
        "var": var,
        "profiles": profiles,
        "time": [_iso(meta[p][0]) for p in profiles],
        "lat": [meta[p][1] for p in profiles],
        "lon": [meta[p][2] for p in profiles],
        "distanceKm": dist,
        "depths": depths,
        "values": values,
    }
