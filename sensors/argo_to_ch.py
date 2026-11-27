"""
argo_to_ch.py

Fetch Argo float profiles in Canadian Pacific and Beaufort waters (`REGIONS`)
from Ifremer's ERDDAP and store them in ClickHouse (`argo_profiles` +
`argo_profile_values`).

Sources: `ArgoFloats` (core: temperature, salinity) and
`ArgoFloats-synthetic-BGC` (oxygen, nitrate, pH, chlorophyll), merged per
profile. Values follow Argo's own QC: a delayed- or adjusted-mode core profile
uses its `_adjusted` columns, a real-time one its raw columns; BGC variables
use `_adjusted` only, since raw real-time BGC (oxygen above all) is biased.
Only QC flags 1, 2, 5 and 8 are kept, positions included (8 is a position
interpolated under ice).

Profiles are revised long after they first arrive (real-time → delayed mode),
so a run fetches month by month and replaces a stored profile whose
`date_update` has moved on; unchanged ones are skipped.

Usage
-----
    uv run python argo_to_ch.py                    # the whole archive (~2 h)
    uv run python argo_to_ch.py --since 2025       # pick up new and revised profiles
    uv run python argo_to_ch.py --region beaufort --year 2015
"""

from __future__ import annotations

import argparse
import csv
import io
import re
from collections import defaultdict
from datetime import datetime, timezone

import gsw
import requests

from ch_helpers import get_ch_client
from ios_casts_to_ch import GROSS_RANGE as IOS_GROSS_RANGE, FetchError, _num, months

ERDDAP = "https://erddap.ifremer.fr/erddap"
CORE, BGC = "ArgoFloats", "ArgoFloats-synthetic-BGC"
TIMEOUT = 600
BATCH_SIZE = 200_000
TIME_FMT = "%Y-%m-%dT%H:%M:%SZ"
FIRST_YEAR = 1999  # Argo's first floats; ERDDAP returns nothing earlier

# [south, north, west, east]. Pacific reaches Station P (50°N 145°W) and the
# southern Gulf of Alaska; Beaufort is the Canadian Arctic's Pacific side.
REGIONS = {
    "pacific": (45.0, 60.0, -150.0, -122.0),
    "beaufort": (66.0, 80.0, -160.0, -120.0),
}

GOOD = {"1", "2", "5", "8"}
# Registry variable → (column, factor to the registry unit). µmol/kg →
# mmol/m³ uses a nominal 1.025 kg/L, as ios_casts_to_ch does. Salinity stays
# practical (PSU), like every other observation source.
CORE_VARS = {"temperature": ("temp", 1.0), "salinity": ("psal", 1.0)}
BGC_VARS = {
    "dissolved_oxygen": ("doxy", 1.025),
    "nitrate": ("nitrate", 1.025),
    "ph_total": ("ph_in_situ_total", 1.0),
    "chlorophyll": ("chla", 1.0),
}
GROSS_RANGE = {**IOS_GROSS_RANGE, "ph_total": (6.5, 9.0)}

META = ["platform_number", "cycle_number", "direction", "time", "latitude", "longitude",
        "position_qc", "date_update", "pres", "pres_qc", "pres_adjusted", "pres_adjusted_qc"]
CORE_COLUMNS = META + ["data_mode", "project_name", "pi_name", "platform_type"] + [
    f"{c}{s}" for c, _ in CORE_VARS.values() for s in ("", "_qc", "_adjusted", "_adjusted_qc")]
BGC_COLUMNS = META + [f"{c}{s}" for c, _ in BGC_VARS.values() for s in ("_adjusted", "_adjusted_qc")]


# ── ERDDAP ────────────────────────────────────────────────────────────────────

def fetch_period(dataset: str, columns: list[str], box: tuple, start: datetime, end: datetime) -> list[dict]:
    """Every row in `box` with `start <= time < end`."""
    s, n, w, e = box
    query = (f"{','.join(columns)}&latitude>={s}&latitude<={n}&longitude>={w}&longitude<={e}"
             f"&time>={start.strftime(TIME_FMT)}&time<{end.strftime(TIME_FMT)}")
    try:
        r = requests.get(f"{ERDDAP}/tabledap/{dataset}.csvp",
                         params=requests.utils.quote(query, safe="&=,"), timeout=TIMEOUT)
    except requests.RequestException as e:
        raise FetchError(str(e)) from e
    if r.status_code == 404:  # ERDDAP's "no matching results"
        return []
    if r.status_code != 200:
        raise FetchError(f"HTTP {r.status_code}: {r.text[:200]}")
    reader = csv.reader(io.StringIO(r.text))
    header = [re.sub(r" \(.*\)$", "", h) for h in next(reader)]
    return [dict(zip(header, row)) for row in reader]


# ── Parsing ───────────────────────────────────────────────────────────────────

def _good(row: dict, col: str, factor: float = 1.0) -> float | None:
    """`col`'s value when its QC flag is good."""
    if row.get(f"{col}_qc", "").strip() not in GOOD:
        return None
    v = _num(row.get(col))
    return None if v is None else v * factor


def _utc(raw: str | None) -> datetime | None:
    try:
        # Aware UTC: clickhouse-connect reads a naive datetime as local time.
        return datetime.strptime(raw or "", TIME_FMT).replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def profile_id(row: dict) -> str:
    """WMO number, cycle and direction (A ascending, D descending): "4902568_123A"."""
    try:
        cycle = int(float(row.get("cycle_number") or ""))
    except ValueError:
        return ""
    platform = (row.get("platform_number") or "").strip()
    return f"{platform}_{cycle:03d}{(row.get('direction') or 'A').strip()}" if platform else ""


def parse_rows(core_rows: list[dict], bgc_rows: list[dict]):
    """(profiles, values): one `argo_profiles` row per profile with a good
    value, and its long-format `argo_profile_values` rows."""
    meta: dict[str, dict] = {}
    values: dict[str, list] = defaultdict(list)
    for rows, is_core in ((core_rows, True), (bgc_rows, False)):
        for row in rows:
            pid = profile_id(row)
            lat, lon = _num(row.get("latitude")), _num(row.get("longitude"))
            t = _utc(row.get("time"))
            if not pid or lat is None or lon is None or t is None or row.get("position_qc", "").strip() not in GOOD:
                continue
            adjusted = not is_core or row.get("data_mode", "").strip() in ("A", "D")
            pres = _good(row, "pres_adjusted") if adjusted else _good(row, "pres")
            if pres is None and not is_core:
                pres = _good(row, "pres")  # synthetic profiles often leave pres_adjusted empty
            if pres is None:
                continue
            m = meta.get(pid)
            if m is None:
                m = meta[pid] = {
                    "profile_id": pid, "platform": row["platform_number"].strip(),
                    "cycle": int(float(row["cycle_number"])), "direction": pid[-1],
                    "time": t, "latitude": lat, "longitude": lon,
                    "data_mode": "", "project": "", "pi": "", "platform_type": "",
                    "date_update": _utc(row.get("date_update")) or t,
                }
            if is_core:
                m.update(data_mode=row.get("data_mode", "").strip(), project=row.get("project_name", "").strip(),
                         pi=row.get("pi_name", "").strip(), platform_type=row.get("platform_type", "").strip())
            m["date_update"] = max(m["date_update"], _utc(row.get("date_update")) or m["date_update"])
            depth = float(-gsw.z_from_p(pres, lat))
            for var, (col, factor) in (CORE_VARS if is_core else BGC_VARS).items():
                v = _good(row, f"{col}_adjusted" if adjusted else col, factor)
                lo, hi = GROSS_RANGE[var]
                if v is not None and lo <= v <= hi:
                    values[pid].append([pid, var, depth, float(v)])

    profiles = []
    for pid, m in meta.items():
        vals = values.get(pid)
        if not vals:
            continue
        m["max_depth"] = max(v[2] for v in vals)
        m["variables"] = sorted({v[1] for v in vals})
        profiles.append(m)
    flat = [v for p in profiles for v in values[p["profile_id"]]]
    return profiles, flat


# ── ClickHouse ────────────────────────────────────────────────────────────────

PROFILE_COLS = ["profile_id", "platform", "cycle", "direction", "time", "latitude", "longitude",
                "data_mode", "project", "pi", "platform_type", "max_depth", "variables", "date_update"]
VALUE_COLS = ["profile_id", "variable", "depth", "value"]


def stored_updates(ch_client, ids: set[str]) -> dict[str, datetime]:
    if not ids:
        return {}
    rows = ch_client.query(
        "SELECT profile_id, max(date_update) FROM argo_profiles WHERE has({ids:Array(String)}, profile_id) GROUP BY profile_id",
        parameters={"ids": sorted(ids)},
    ).result_rows
    return {pid: (t if t.tzinfo else t.replace(tzinfo=timezone.utc)) for pid, t in rows}


def store(ch_client, profiles: list[dict], values: list[list], replace: set[str]):
    if replace:
        ch_client.command(
            "DELETE FROM argo_profile_values WHERE has({ids:Array(String)}, profile_id)",
            parameters={"ids": sorted(replace)},
        )
    for i in range(0, len(values), BATCH_SIZE):
        ch_client.insert("argo_profile_values", values[i:i + BATCH_SIZE], column_names=VALUE_COLS)
    if profiles:
        ch_client.insert("argo_profiles", [[p[k] for k in PROFILE_COLS] for p in profiles], column_names=PROFILE_COLS)


def changed(profiles: list[dict], stored: dict[str, datetime]) -> set[str]:
    """Ids of profiles that are new or revised since they were stored."""
    return {p["profile_id"] for p in profiles
            if p["profile_id"] not in stored or p["date_update"] > stored[p["profile_id"]]}


# ── Driver ────────────────────────────────────────────────────────────────────

def harvest(region: str, since: int | None, until: int | None) -> int:
    ch_client = get_ch_client()
    box = REGIONS[region]
    first = datetime(since or FIRST_YEAR, 1, 1, tzinfo=timezone.utc)
    last = min(datetime.now(timezone.utc), datetime(until or 9999, 12, 31, tzinfo=timezone.utc))
    print(f"\n{region} {box}: {first:%Y-%m} to {last:%Y-%m}")

    total = total_values = failed = 0
    for start, end in months(first, last):
        try:
            core = fetch_period(CORE, CORE_COLUMNS, box, start, end)
            bgc = fetch_period(BGC, BGC_COLUMNS, box, start, end)
        except FetchError as e:
            print(f"  {start:%Y-%m}  ERROR {e}")
            failed += 1
            continue
        profiles, values = parse_rows(core, bgc)
        stored = stored_updates(ch_client, {p["profile_id"] for p in profiles})
        keep = changed(profiles, stored)
        profiles = [p for p in profiles if p["profile_id"] in keep]
        values = [v for v in values if v[0] in keep]
        store(ch_client, profiles, values, keep & stored.keys())
        total += len(profiles)
        total_values += len(values)
        if profiles:
            print(f"  {start:%Y-%m}  {len(profiles):4d} profile(s), {len(values):7d} value(s)")
    print(f"{region}: {total} profile(s), {total_values} value(s) stored; {failed} month(s) failed")
    return failed


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Argo floats (Ifremer ERDDAP) in Canadian waters → ClickHouse.")
    p.add_argument("--region", action="append", choices=sorted(REGIONS), help="Repeatable; all when omitted.")
    p.add_argument("--year", type=int, help="Only this year (same as --since Y --until Y).")
    p.add_argument("--since", type=int, metavar="YEAR")
    p.add_argument("--until", type=int, metavar="YEAR")
    args = p.parse_args()
    since = args.year or args.since
    until = args.year or args.until
    failures = sum(harvest(r, since, until) for r in (args.region or list(REGIONS)))
    raise SystemExit(1 if failures else 0)
