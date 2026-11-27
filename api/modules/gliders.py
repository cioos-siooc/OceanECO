"""C-PROOF glider deployments (sensors/cproof_to_ch.py) and Argo floats
(sensors/argo_to_ch.py).

A deployment is a moving profiler: every profile carries its own fix, so its
data lives in `glider_profiles` rather than `sensor_timeseries`, and the map
draws a track instead of a marker.

`list_gliders()` feeds the map and the sensor list, with each track simplified
to its shape. `extract_glider_section()` returns one variable as a depth x
column grid in the shape `glider/GliderSectionChart.vue` takes: a window of the
deployment's profiles (all of them by default), averaged into at most
MAX_COLUMNS x MAX_ROWS cells, plus each column's time, position and
along-track distance.

An Argo float is served as a deployment too, with id "argo-<WMO>" and its
cycles as profiles (`argo_profiles_sql`), so the map, section and Area code
treat both alike. `list_argo()` lists the floats in `list_gliders()`' shape.
"""
from __future__ import annotations

import math
import time
from bisect import bisect_left, bisect_right

import numpy as np
from cachetools import TTLCache, cached

from modules.clickhouse_helpers import get_ch_client

# A long mission runs to ~3500 profiles x ~1000 one-metre bins: millions of
# cells, tens of MB as JSON. Averaged down to this, a section stays under ~1 MB
# and still resolves every dive cycle at panel width; zooming in asks again for
# a narrower window, down to single profiles.
MAX_COLUMNS = 600
MAX_ROWS = 256
# Track simplification tolerance (degrees, ~200 m): far below what the map
# shows at the zooms a whole deployment fits in.
TRACK_TOLERANCE_DEG = 0.002
# Longest step between kept track vertices that isn't a gap in the data; the
# frontend's obsFilter.ts TRACK_GAP_S must match.
TRACK_MAX_STEP_S = 12 * 3600


ARGO_PREFIX = "argo-"
# A float is live while its last profile is this recent (it surfaces every ~10 days).
ARGO_LIVE_DAYS = 30


def is_argo(deployment_id: str) -> bool:
    return deployment_id.startswith(ARGO_PREFIX)


def argo_profiles_sql(ids: str) -> str:
    """Argo values in glider_profiles' columns, as a subquery, for the float
    ids ("argo-<WMO>") in the SQL array `ids` (a parameter or literal). The
    values are read through their own primary key, never scanned whole."""
    in_ids = f"concat('{ARGO_PREFIX}', platform) IN {ids}"
    return (
        f"(SELECT concat('{ARGO_PREFIX}', p.platform) AS deployment_id, p.cycle AS profile, p.time AS time, "
        "p.latitude AS latitude, p.longitude AS longitude, v.variable AS variable, v.depth AS depth, v.value AS value "
        "FROM argo_profile_values AS v INNER JOIN ("
        f"SELECT profile_id, platform, cycle, time, latitude, longitude FROM argo_profiles FINAL WHERE {in_ids}"
        ") AS p USING profile_id "
        f"WHERE v.profile_id IN (SELECT profile_id FROM argo_profiles WHERE {in_ids}))"
    )


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _iso(dt) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _simplify(points: list[tuple], tol: float, max_gap_s: float | None = None) -> list[tuple]:
    """Ramer–Douglas–Peucker on each point's leading (lon, lat), iterative;
    anything after them (a time) rides along with its vertex.

    With `max_gap_s`, points carry a time third and extra vertices are kept so
    no two consecutive ones are more than `max_gap_s` apart unless the data
    itself is: a longer step between kept vertices then always means a gap in
    the data, which the map won't draw a clipped track across.
    """
    if len(points) < 3:
        return points
    xy = np.asarray([p[:2] for p in points], dtype=float)
    keep = np.zeros(len(xy), dtype=bool)
    keep[[0, -1]] = True
    stack = [(0, len(xy) - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        seg = xy[b] - xy[a]
        rel = xy[a + 1:b] - xy[a]
        norm = math.hypot(*seg)
        d = (np.abs(seg[0] * rel[:, 1] - seg[1] * rel[:, 0]) / norm if norm
             else np.hypot(rel[:, 0], rel[:, 1]))
        i = int(np.argmax(d))
        if d[i] > tol:
            keep[a + 1 + i] = True
            stack += [(a, a + 1 + i), (a + 1 + i, b)]
    if max_gap_s is not None:
        last = 0
        for i in range(1, len(points)):
            if keep[i]:
                last = i
            elif points[i + 1][2] - points[last][2] > max_gap_s:
                keep[i] = True
                last = i
    return [points[i] for i in np.flatnonzero(keep)]


# The harvester runs every few hours; the track query scans every profile.
@cached(TTLCache(maxsize=1, ttl=300))
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
    for dep, lat, lon, t in client.query("""
        SELECT deployment_id, any(latitude), any(longitude), toUnixTimestamp(any(time))
        FROM glider_profiles
        GROUP BY deployment_id, profile
        ORDER BY deployment_id, profile
    """).result_rows:
        tracks.setdefault(dep, []).append((lon, lat, int(t)))
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
            # [lon, lat, unix seconds], simplified; the section carries the
            # per-profile fixes. The time lets the map clip a track to the
            # observation period.
            "track": [[round(lon, 5), round(lat, 5), t] for lon, lat, t in _simplify(track, TRACK_TOLERANCE_DEG, TRACK_MAX_STEP_S)],
        })
    return out


def _fill_vertical_gaps(grid: np.ndarray) -> None:
    """Interpolate each column's empty rows between its shallowest and deepest
    value, in place. Argo samples every 1-2 dbar near the surface but only
    every 10-50 dbar at depth, so uniform rows leave stripes there."""
    rows = np.arange(grid.shape[0])
    for c in range(grid.shape[1]):
        col = grid[:, c]
        ok = ~np.isnan(col)
        if ok.sum() > 1:
            inside = (rows > rows[ok][0]) & (rows < rows[ok][-1]) & ~ok
            col[inside] = np.interp(rows[inside], rows[ok], col[ok])


@cached(TTLCache(maxsize=1, ttl=300))
def list_argo() -> list[dict]:
    """Every Argo float in `list_gliders()`' shape, its track one fix per profile."""
    client = get_ch_client()
    try:
        rows = client.query("""
            SELECT platform, any(platform_type), any(project), any(pi), min(time), max(time),
                   min(latitude), max(latitude), min(longitude), max(longitude), count(),
                   groupUniqArrayArray(variables),
                   arraySort(x -> x.3, groupArray((longitude, latitude, toUnixTimestamp(time))))
            FROM argo_profiles FINAL
            GROUP BY platform
            ORDER BY max(time) DESC
        """).result_rows
    finally:
        client.close()
    live_after = time.time() - ARGO_LIVE_DAYS * 86400
    out = []
    for (wmo, platform, project, pi, start, end, lat0, lat1, lon0, lon1, n, variables, track) in rows:
        dist = sum(_haversine_km(a[1], a[0], b[1], b[0]) for a, b in zip(track, track[1:]))
        out.append({
            "id": f"{ARGO_PREFIX}{wmo}",
            "kind": "argo",
            "glider": wmo,
            "platformType": platform,
            "summary": " · ".join(x for x in (project, pi and f"PI {pi.title()}") if x),
            "station": "",
            "start": _iso(start),
            "end": _iso(end),
            "bbox": [lon0, lat0, lon1, lat1],
            "profiles": int(n),
            "distanceKm": round(dist, 1),
            "variables": sorted(variables),
            "fileUrl": f"https://fleetmonitoring.euro-argo.eu/float/{wmo}",
            "variant": "",
            "active": track[-1][2] >= live_after,
            "track": [[round(lon, 5), round(lat, 5), int(t)] for lon, lat, t in track],
        })
    return out


def extract_glider_section(deployment_id: str, var: str,
                           start: int | None = None, end: int | None = None) -> dict:
    """One variable of one deployment as a depth x column grid.

    `start`/`end` bound the window by profile number (inclusive); without them
    it is the whole deployment. Each column averages `perColumn` consecutive
    profiles and each row `perRow` depth bins, so the grid never exceeds
    MAX_COLUMNS x MAX_ROWS. The depth rows cover the whole deployment, so they
    are the same for every window.

    Response: { extent: [first, last profile of the deployment], perColumn,
                profiles: [first profile of each column], profileEnd: [last ...],
                time, lat, lon, distanceKm: [... of each column's middle profile],
                depths: [row centres], values: [[float|null]] } — values is rows x columns.
    """
    client = get_ch_client()
    params = {"d": deployment_id, "v": var}
    table = argo_profiles_sql("[{d:String}]") if is_argo(deployment_id) else "glider_profiles"
    meta = client.query(
        f"""
        SELECT profile, any(time), any(latitude), any(longitude)
        FROM {table}
        WHERE deployment_id = {{d:String}} AND variable = {{v:String}}
        GROUP BY profile
        ORDER BY profile
        """,
        parameters=params,
    ).result_rows
    if not meta:
        raise ValueError(f"No {var} data for glider deployment {deployment_id}")
    profiles = [int(r[0]) for r in meta]

    # Distance from the start of the deployment, whatever the window.
    dist, total = [0.0], 0.0
    for a, b in zip(meta, meta[1:]):
        total += _haversine_km(a[2], a[3], b[2], b[3])
        dist.append(total)

    i0 = bisect_left(profiles, start) if start is not None else 0
    i1 = bisect_right(profiles, end) if end is not None else len(profiles)
    if i1 <= i0:
        raise ValueError(f"No {var} profiles of {deployment_id} in {start}–{end}")
    per_col = math.ceil((i1 - i0) / MAX_COLUMNS)
    col_starts = list(range(i0, i1, per_col))
    window = profiles[i0:i1]
    col_of = [(i - i0) // per_col for i in range(i0, i1)]

    d_min, d_max, n_depths = client.query(
        f"""
        SELECT min(depth), max(depth), uniqExact(depth)
        FROM {table}
        WHERE deployment_id = {{d:String}} AND variable = {{v:String}}
        """,
        parameters=params,
    ).first_row
    native = (d_max - d_min) / (n_depths - 1) if n_depths > 1 else 1.0
    per_row = math.ceil(n_depths / MAX_ROWS)
    step = native * per_row
    n_rows = math.ceil(n_depths / per_row)

    grid = np.full((n_rows, len(col_starts)), np.nan)
    for c, r, v in client.query(
        f"""
        SELECT transform(profile, {{ps:Array(UInt32)}}, {{cs:Array(UInt32)}}, 0) AS c,
               toUInt32(floor((depth - {{d0:Float64}}) / {{step:Float64}} + 1e-6)) AS r,
               avg(value)
        FROM {table}
        WHERE deployment_id = {{d:String}} AND variable = {{v:String}}
          AND profile BETWEEN {{p0:UInt32}} AND {{p1:UInt32}}
          AND isFinite(value)
        GROUP BY c, r
        """,
        parameters={**params, "ps": window, "cs": col_of, "d0": float(d_min), "step": step,
                    "p0": window[0], "p1": window[-1]},
    ).result_rows:
        if r < n_rows:
            grid[r, c] = v

    if is_argo(deployment_id):
        _fill_vertical_gaps(grid)

    mids = [(a + min(a + per_col, i1) - 1) // 2 for a in col_starts]
    return {
        "deployment": deployment_id,
        "var": var,
        "extent": [profiles[0], profiles[-1]],
        "perColumn": per_col,
        "profiles": [profiles[a] for a in col_starts],
        "profileEnd": [profiles[min(a + per_col, i1) - 1] for a in col_starts],
        "time": [_iso(meta[m][1]) for m in mids],
        "lat": [round(meta[m][2], 5) for m in mids],
        "lon": [round(meta[m][3], 5) for m in mids],
        "distanceKm": [round(dist[m], 2) for m in mids],
        "depths": [round(float(d_min) + r * step + (per_row - 1) * native / 2, 2) for r in range(n_rows)],
        "values": [[None if math.isnan(v) else round(float(v), 4) for v in row] for row in grid],
    }
