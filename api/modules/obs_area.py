"""Every observation of one variable inside a 4D box: a circle on the map, a
depth range, and the observation period (front/app/utils/obsFilter.ts).

It reads only the sources the map is showing, as the frontend lists them:
the visible sensors (moorings, ONC sites; a display-time merge arrives as its
members' ids), the visible glider deployments and Argo floats, and the ship casts when their
layer is on. Nothing else in the box is read.

A platform is one sensor, one glider deployment, or one cast. Sensor and
glider rows are binned per platform in ClickHouse (mean, min, max, count and
mean depth per time bin), so an hourly mooring over decades stays a few
thousand points; a cast is one point, its values in the depth range averaged.
The frontend plots these points as they are, or averages them across
platforms per bin (each platform once, so an hourly mooring doesn't drown a
monthly cast).

Depth: a fixed-depth sensor's rows are stored at depth 0, so its catalog depth
is what the depth range tests; a profiler's (depth -1) and a glider's or
cast's rows carry their own.
"""
from __future__ import annotations

import math
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from modules.clickhouse_helpers import get_ch_client
from modules.gliders import argo_profiles_sql, is_argo
from modules.ship_casts import _iso, cast_filter_sql, daylight_sql, variable_meta

MAX_RADIUS_KM = 200
# Past this many points the bins widen (day → week → month → year).
MAX_POINTS = 20_000
# A box this short or shorter in time is binned hourly instead of daily.
HOURLY_SPAN = timedelta(days=21)
# Casts beyond this many keep the latest.
MAX_CASTS = 5_000
# Glider fixes per deployment returned for the Area tab's 3D view.
GLIDER_SAMPLES = 400

BINS = ("hour", "day", "week", "month", "year")
# Week, month and year starts are Dates in ClickHouse; toDateTime keeps every
# bin a datetime, so they sort alongside casts' times.
_BIN_SQL = {
    "hour": "toStartOfHour({t})",
    "day": "toStartOfDay({t})",
    "week": "toDateTime(toStartOfWeek({t}, 1))",  # weeks start on Monday
    "month": "toDateTime(toStartOfMonth({t}))",
    "year": "toDateTime(toStartOfYear({t}))",
}


def _bin_start(dt: datetime, unit: str) -> datetime:
    """Start of `dt`'s bin, matching _BIN_SQL."""
    if unit == "hour":
        return dt.replace(minute=0, second=0, microsecond=0)
    day = dt.replace(hour=0, minute=0, second=0, microsecond=0)
    if unit == "day":
        return day
    if unit == "week":
        return day - timedelta(days=day.weekday())
    if unit == "month":
        return day.replace(day=1)
    return day.replace(month=1, day=1)


def _rebin(rows: list[tuple], unit: str) -> list[tuple]:
    """Re-aggregate (platform, bin, mean, min, max, n, depth) rows into wider bins."""
    acc: dict[tuple, list] = {}
    for p, b, mean, lo, hi, n, depth in rows:
        k = (p, _bin_start(b, unit))
        a = acc.get(k)
        if a is None:
            acc[k] = [mean * n, lo, hi, n, depth * n]
        else:
            a[0] += mean * n
            a[1] = min(a[1], lo)
            a[2] = max(a[2], hi)
            a[3] += n
            a[4] += depth * n
    return [(p, b, s / n, lo, hi, n, d / n) for (p, b), (s, lo, hi, n, d) in acc.items()]


def _is_uuid(value: str) -> bool:
    try:
        uuid.UUID(str(value))
        return True
    except ValueError:
        return False


def _circle_sql(lat_col: str, lon_col: str) -> str:
    return f"greatCircleDistance({lon_col}, {lat_col}, {{lon:Float64}}, {{lat:Float64}}) <= {{r:Float64}}"


def _period_sql(column: str, period: dict) -> tuple[str, dict]:
    return cast_filter_sql(period.get("from"), period.get("to"), period.get("months"),
                           period.get("doy"), period.get("half"), column=column)


def _diel_sql(diel: str, time: str, lat: str, lon: str) -> str:
    if diel == "day":
        return f" AND {daylight_sql(time, lat, lon)}"
    if diel == "night":
        return f" AND NOT {daylight_sql(time, lat, lon)}"
    return ""


def _sensor_rows(client, ids: list[str], base: dict, period: dict, diel: str, unit: str):
    """(platforms, rows) for the listed sensors inside the circle."""
    if not ids:
        return [], []
    found = client.query(
        "SELECT toString(id), name, latitude, longitude, depth, organization, "
        f"greatCircleDistance(longitude, latitude, {{lon:Float64}}, {{lat:Float64}}) "
        f"FROM sensors FINAL WHERE id IN {{ids:Array(UUID)}} AND {_circle_sql('latitude', 'longitude')}",
        parameters={**base, "ids": ids},
    ).result_rows
    if not found:
        return [], []
    sid = [r[0] for r in found]
    lats = [float(r[2]) for r in found]
    lons = [float(r[3]) for r in found]
    depths = [float(r[4]) for r in found]
    # Per-row position and depth without a join: each sensor's own, by id.
    lat_e = "transform(toString(sensor_id), {sid:Array(String)}, {slat:Array(Float64)}, 0.)"
    lon_e = "transform(toString(sensor_id), {sid:Array(String)}, {slon:Array(Float64)}, 0.)"
    cat_depth = "transform(toString(sensor_id), {sid:Array(String)}, {sdep:Array(Float64)}, -1.)"
    depth_e = f"if({cat_depth} = -1, toFloat64(depth), {cat_depth})"
    period_where, period_params = _period_sql("time", period)
    rows = client.query(
        f"SELECT toString(sensor_id), {_BIN_SQL[unit].format(t='time')} AS b, "
        f"avg(value), min(value), max(value), count(), avg({depth_e}) "
        "FROM sensor_timeseries FINAL "
        "WHERE sensor_id IN {sidu:Array(UUID)} AND variable = {v:String} AND NOT isNaN(value) "
        f"AND {depth_e} BETWEEN {{d0:Float64}} AND {{d1:Float64}} AND {period_where}"
        f"{_diel_sql(diel, 'time', lat_e, lon_e)} "
        "GROUP BY sensor_id, b",
        parameters={**base, **period_params, "sid": sid, "sidu": sid, "slat": lats, "slon": lons, "sdep": depths},
    ).result_rows
    present = {r[0] for r in rows}
    platforms = [{
        "id": r[0], "type": "sensor", "name": r[1], "lat": float(r[2]), "lon": float(r[3]),
        "depth": None if float(r[4]) == -1 else float(r[4]), "organization": r[5],
        "distanceKm": round(float(r[6]) / 1000, 2),
    } for r in found if r[0] in present]
    return platforms, rows


def _moving_tables(ids: list[str]) -> list[tuple[str, str]]:
    """(table, type) per kind of moving platform in `ids`: glider deployments
    or Argo floats, both in glider_profiles' columns, for the {g:Array(String)}
    parameter."""
    out = []
    if any(not is_argo(i) for i in ids):
        out.append(("glider_profiles", "glider"))
    if any(is_argo(i) for i in ids):
        out.append((argo_profiles_sql("{g:Array(String)}"), "argo"))
    return out


def _glider_rows(client, ids: list[str], base: dict, period: dict, diel: str, unit: str):
    """(platforms, rows) for the listed glider deployments' and Argo floats'
    fixes inside the circle."""
    if not ids:
        return [], []
    # Deployments whose bounding box can reach the circle; the rows' own fixes
    # decide. Argo floats skip this: their profile table is small.
    dlat = base["r"] / 111_320
    dlon = dlat / max(math.cos(math.radians(base["lat"])), 0.01)
    gliders = [i for i in ids if not is_argo(i)]
    near = [r[0] for r in client.query(
        "SELECT deployment_id FROM glider_deployments FINAL WHERE deployment_id IN {ids:Array(String)} "
        "AND lat_max >= {la0:Float64} AND lat_min <= {la1:Float64} AND lon_max >= {lo0:Float64} AND lon_min <= {lo1:Float64}",
        parameters={"ids": gliders, "la0": base["lat"] - dlat, "la1": base["lat"] + dlat,
                    "lo0": base["lon"] - dlon, "lo1": base["lon"] + dlon},
    ).result_rows] if gliders else []
    near += [i for i in ids if is_argo(i)]
    if not near:
        return [], []
    period_where, period_params = _period_sql("time", period)
    platforms, rows = [], []
    for table, kind in _moving_tables(near):
        found = client.query(
            f"SELECT deployment_id, {_BIN_SQL[unit].format(t='time')} AS b, "
            "avg(value), min(value), max(value), count(), avg(depth) "
            f"FROM {table} "
            "WHERE deployment_id IN {g:Array(String)} AND variable = {v:String} AND NOT isNaN(value) "
            f"AND depth BETWEEN {{d0:Float64}} AND {{d1:Float64}} AND {_circle_sql('latitude', 'longitude')} "
            f"AND {period_where}{_diel_sql(diel, 'time', 'latitude', 'longitude')} "
            "GROUP BY deployment_id, b",
            parameters={**base, **period_params, "g": [i for i in near if is_argo(i) == (kind == "argo")]},
        ).result_rows
        present = {r[0] for r in found}
        platforms += [{"id": g, "type": kind, "name": g} for g in near if g in present]
        rows += found
    return platforms, rows


def _glider_samples(client, platforms: list[dict], base: dict, period: dict, diel: str) -> None:
    """Give each glider platform `samples`: up to GLIDER_SAMPLES of its
    (lon, lat, depth) fixes in the box, for plotting where it went."""
    if not platforms:
        return
    period_where, period_params = _period_sql("time", period)
    ids = [p["id"] for p in platforms]
    found = {}
    for table, kind in _moving_tables(ids):
        found.update(client.query(
            "SELECT deployment_id, groupArraySample({k:UInt32}, 1)((longitude, latitude, depth)) "
            f"FROM {table} "
            "WHERE deployment_id IN {g:Array(String)} AND variable = {v:String} AND NOT isNaN(value) "
            f"AND depth BETWEEN {{d0:Float64}} AND {{d1:Float64}} AND {_circle_sql('latitude', 'longitude')} "
            f"AND {period_where}{_diel_sql(diel, 'time', 'latitude', 'longitude')} "
            "GROUP BY deployment_id",
            parameters={**base, **period_params, "g": [i for i in ids if is_argo(i) == (kind == "argo")], "k": GLIDER_SAMPLES},
        ).result_rows)
    for p in platforms:
        p["samples"] = [[round(float(lo), 5), round(float(la), 5), round(float(d), 1)] for lo, la, d in found.get(p["id"], [])]


def _cast_points(client, base: dict, period: dict, diel: str):
    """(platforms, rows, truncated, total) for casts inside the circle: one
    row per cast, its values in the depth range averaged."""
    period_where, period_params = _period_sql("time", period)
    where = (f"{_circle_sql('latitude', 'longitude')} AND has(variables, {{v:String}}) AND {period_where}"
             f"{_diel_sql(diel, 'time', 'latitude', 'longitude')}")
    params = {**base, **period_params}
    casts = client.query(
        "SELECT cast_id, kind, time, latitude, longitude, mission_id, "
        "greatCircleDistance(longitude, latitude, {lon:Float64}, {lat:Float64}) "
        f"FROM ship_casts FINAL WHERE {where} ORDER BY time DESC LIMIT {{n:UInt32}}",
        parameters={**params, "n": MAX_CASTS + 1},
    ).result_rows
    truncated = len(casts) > MAX_CASTS
    total = (client.query(f"SELECT count() FROM ship_casts FINAL WHERE {where}", parameters=params).first_row[0]
             if truncated else len(casts))
    casts = casts[:MAX_CASTS]
    if not casts:
        return [], [], False, 0
    by_id = {c[0]: c for c in casts}
    rows = client.query(
        "SELECT cast_id, avg(value), min(value), max(value), count(), avg(depth) FROM ship_cast_values "
        "WHERE cast_id IN {ids:Array(String)} AND variable = {v:String} AND NOT isNaN(value) "
        "AND depth BETWEEN {d0:Float64} AND {d1:Float64} GROUP BY cast_id",
        parameters={**base, "ids": list(by_id)},
    ).result_rows
    platforms = []
    out = []
    for cid, mean, lo, hi, n, depth in rows:
        c = by_id[cid]
        platforms.append({
            "id": cid, "type": c[1], "name": c[5] or cid, "lat": float(c[3]), "lon": float(c[4]),
            "distanceKm": round(float(c[6]) / 1000, 2),
        })
        out.append((cid, c[2], mean, lo, hi, n, depth))
    # Untruncated, count only casts with a value in the depth range.
    return platforms, out, truncated, int(total) if truncated else len(out)


def obs_area(variable: str, lat: float, lon: float, radius_km: float,
             depth_min: float, depth_max: float, period: Optional[dict] = None,
             diel: str = "all", sensor_ids: Optional[list[str]] = None,
             glider_ids: Optional[list[str]] = None, casts: bool = False,
             bin: str = "auto") -> dict:
    """Points of `variable` in the box from the listed sources; see the module
    docstring. `period` holds the obsFilter's resolved from/to/months/doy/half."""
    if variable not in variable_meta():
        raise ValueError(f"Unknown variable {variable!r}")
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("lat/lon out of range")
    if not 0 < radius_km <= MAX_RADIUS_KM:
        raise ValueError(f"radiusKm must be in (0, {MAX_RADIUS_KM}]")
    if depth_max < depth_min:
        raise ValueError("depthMax must not be above depthMin")
    if diel not in ("all", "day", "night"):
        raise ValueError("diel must be all, day or night")
    if bin != "auto" and bin not in BINS:
        raise ValueError(f"bin must be auto or one of {', '.join(BINS)}")
    period = period or {}
    _period_sql("time", period)  # validate before querying
    sensor_ids = [i for i in (sensor_ids or []) if _is_uuid(i)]

    base = {"v": variable, "lat": float(lat), "lon": float(lon), "r": float(radius_km) * 1000,
            "d0": float(depth_min), "d1": float(depth_max)}
    unit = "day" if bin == "auto" else bin
    client = get_ch_client()
    try:
        def binned(u: str):
            s = _sensor_rows(client, sensor_ids or [], base, period, diel, u)
            g = _glider_rows(client, glider_ids or [], base, period, diel, u)
            return s, g

        (sp, sr), (gp, gr) = binned(unit)
        if bin == "auto" and (sr or gr):
            times = [r[1] for r in sr + gr]
            if max(times) - min(times) <= HOURLY_SPAN:
                unit = "hour"
                (sp, sr), (gp, gr) = binned(unit)
        _glider_samples(client, gp, base, period, diel)
        cp, cr, casts_truncated, casts_total = (_cast_points(client, base, period, diel)
                                                 if casts else ([], [], False, 0))
    finally:
        client.close()

    rows = sr + gr
    if bin == "auto":
        for wider in BINS[BINS.index(unit) + 1:]:
            if len(rows) + len(cr) <= MAX_POINTS:
                break
            rows, unit = _rebin(rows, wider), wider

    platforms = sp + gp + cp
    index = {p["id"]: i for i, p in enumerate(platforms)}
    points = sorted(rows + cr, key=lambda r: r[1])
    return {
        "variable": variable,
        "bin": unit,
        "platforms": platforms,
        "points": {
            "platform": [index[r[0]] for r in points],
            "time": [_iso(r[1]) for r in points],
            "value": [float(r[2]) for r in points],
            "min": [float(r[3]) for r in points],
            "max": [float(r[4]) for r in points],
            "n": [int(r[5]) for r in points],
            "depth": [round(float(r[6]), 1) for r in points],
        },
        "castsTruncated": casts_truncated,
        "castsTotal": casts_total,
    }
