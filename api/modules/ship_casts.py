"""DFO IOS ship casts (CTD and rosette bottle), harvested by sensors/ios_casts_to_ch.py.

A cast is one vertical profile at one position and moment, so it lives in
`ship_casts` / `ship_cast_values` rather than as a sensor. Nothing here is
limited to a model's domain or period: the archive runs back to 1930 and well
beyond BC, and a model comparison is offered only where a model has data.

`cast_years()` feeds the layer's period picker, `list_casts()` the map points
for a period, and `cast_profile()` one cast's profiles (plus, for a modelled
variable, the model's profile at the nearest cell and time when there is one).
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from cachetools import TTLCache, cached

from modules.clickhouse_helpers import get_ch_client
from modules.extractTimeseries import ALLOWED_VARIABLES, DATA_TABLE_BY_SOURCE, OutsideDomainError
from modules.extract_profile import extract_profile
from shared.variable_config import load_variable_config

# A period's points go to the map in one response; past this many the map
# would be unreadable anyway, so the picker steers to a shorter period.
MAX_CASTS = 20_000

logger = logging.getLogger(__name__)


def variable_meta() -> dict:
    """Labels for every variable a cast can carry: the model registry plus its
    observation-only section (shared/variable_config.yml)."""
    config = load_variable_config()
    out = {}
    for section, modelled in (("variables", True), ("observed_variables", False)):
        for var, meta in (config.get(section) or {}).items():
            out[var] = {
                "name": meta.get("name", var),
                "short": meta.get("short", meta.get("name", var)),
                "unit": meta.get("unit", ""),
                "precision": meta.get("precision"),
                "modelled": modelled,
            }
    return out


def _iso(dt) -> str:
    return dt.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_day(value: str, name: str) -> datetime:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError as exc:
        raise ValueError(f"Invalid {name} {value!r}: expected an ISO date") from exc


@cached(TTLCache(maxsize=1, ttl=300))
def cast_years() -> list[dict]:
    """Cast counts per year and kind, oldest first."""
    client = get_ch_client()
    try:
        rows = client.query(
            "SELECT toYear(time) AS y, kind, count() FROM ship_casts FINAL GROUP BY y, kind ORDER BY y"
        ).result_rows
    finally:
        client.close()
    years: dict[int, dict] = {}
    for y, kind, n in rows:
        years.setdefault(int(y), {"year": int(y), "ctd": 0, "bottle": 0})[kind] = int(n)
    return list(years.values())


def list_casts(from_date: str, to_date: str) -> dict:
    """Casts with `from_date <= time < to_date`, for the map."""
    t_from, t_to = _parse_day(from_date, "from"), _parse_day(to_date, "to")
    if t_to <= t_from:
        raise ValueError("'to' must be after 'from'")
    client = get_ch_client()
    try:
        rows = client.query(
            "SELECT cast_id, kind, time, latitude, longitude, mission_id, geographic_area, max_depth, variables "
            "FROM ship_casts FINAL WHERE time >= {f:DateTime} AND time < {t:DateTime} "
            "ORDER BY time LIMIT {n:UInt32}",
            parameters={"f": t_from, "t": t_to, "n": MAX_CASTS + 1},
        ).result_rows
    finally:
        client.close()
    truncated = len(rows) > MAX_CASTS
    casts = [{
        "id": r[0], "kind": r[1], "time": _iso(r[2]),
        "lat": round(float(r[3]), 5), "lon": round(float(r[4]), 5),
        "mission": r[5], "area": r[6], "maxDepth": round(float(r[7]), 1), "variables": list(r[8]),
    } for r in rows[:MAX_CASTS]]
    return {"casts": casts, "truncated": truncated, "variables": variable_meta()}


def _model_profile(source: str, var: str, lat: float, lon: float, t: datetime) -> tuple[Optional[dict], Optional[dict]]:
    """(model, error): the model's profile at the cast — the nearest hour when
    one is within an hour, else that day's mean — or why there is none."""
    if source not in DATA_TABLE_BY_SOURCE or var not in ALLOWED_VARIABLES:
        return None, {"code": "not_modelled", "message": "This variable isn't modelled."}
    for bin_mode in ("hourly", "daily"):
        try:
            rows = extract_profile(source=source, var=var, lat=lat, lon=lon, dt=t.isoformat(), bin_mode=bin_mode)
        except OutsideDomainError as exc:
            return None, exc.to_payload()
        except RuntimeError:
            continue
        except Exception:
            # The overlay is a bonus: a failing model read must not take the
            # cast down with it.
            logger.exception("cast model profile failed")
            return None, {"code": "model_unavailable", "message": f"{source} couldn't be read here."}
        if rows:
            return {
                "source": source, "binMode": bin_mode,
                "depth": [r["depth"] for r in rows], "value": [r["value"] for r in rows],
            }, None
    return None, {"code": "no_model_time", "message": f"{source} has no data for this cast's date."}


def cast_profile(cast_id: str, source: Optional[str] = None, model_var: Optional[str] = None) -> dict:
    """One cast: its metadata and every variable's profile; with `model_var`,
    also the model's profile for that variable (`model` null plus
    `modelError` when the model has none here)."""
    client = get_ch_client()
    try:
        meta = client.query(
            "SELECT cast_id, dataset, kind, mission_id, time, latitude, longitude, geographic_area, max_depth "
            "FROM ship_casts FINAL WHERE cast_id = {c:String} LIMIT 1",
            parameters={"c": cast_id},
        ).result_rows
        if not meta:
            raise FileNotFoundError(f"No cast {cast_id!r}")
        rows = client.query(
            "SELECT variable, depth, value FROM ship_cast_values WHERE cast_id = {c:String} "
            "ORDER BY variable, depth",
            parameters={"c": cast_id},
        ).result_rows
    finally:
        client.close()

    m = meta[0]
    profiles: dict[str, dict] = {}
    for var, depth, value in rows:
        p = profiles.setdefault(var, {"depth": [], "value": []})
        p["depth"].append(round(float(depth), 2))
        p["value"].append(float(value))

    out = {
        "cast": {
            "id": m[0], "dataset": m[1], "kind": m[2], "mission": m[3], "time": _iso(m[4]),
            "lat": float(m[5]), "lon": float(m[6]), "area": m[7], "maxDepth": float(m[8]),
        },
        "profiles": profiles,
        "model": None,
        "modelError": None,
    }
    if model_var and source:
        out["model"], out["modelError"] = _model_profile(source, model_var, float(m[5]), float(m[6]), m[4])
    return out
