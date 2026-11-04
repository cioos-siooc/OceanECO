"""
ios_casts_to_ch.py

Fetch DFO Institute of Ocean Sciences ship casts from CIOOS Pacific's ERDDAP
and store them in ClickHouse (`ship_casts` + `ship_cast_values`).

Sources: `IOS_CTD_Profiles` (CTD casts, about 1 m bins) and
`IOS_BOT_Profiles` (rosette bottles: discrete samples, with nutrients and
extracted chlorophyll). Nothing is limited to a model domain or period: the
archive runs back to 1930 and well beyond BC.

The datasets carry several columns per quantity, filled differently from
file to file (`sea_water_temperature` or `TEMPST01`, `DOXYZZ01` in mL/L or
`DOXMZZ01` in µmol/kg, ...). Each row takes the first candidate with a value
(`CANDIDATES`), converted to the registry unit. The IOS quality flags aren't
published through ERDDAP, so values outside a gross range are dropped.

Casts are delayed-mode, so a run fetches month by month and skips casts it
already holds; `--force` replaces a period's casts instead.

Usage
-----
    uv run python ios_casts_to_ch.py --year 2024                 # both datasets
    uv run python ios_casts_to_ch.py --dataset IOS_BOT_Profiles  # whole archive
    uv run python ios_casts_to_ch.py --since 2023 --force
"""

from __future__ import annotations

import argparse
import csv
import io
import math
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import gsw
import requests

from ch_helpers import get_ch_client

ERDDAP = "https://data.cioospacific.ca/erddap"
DATASETS = {"IOS_CTD_Profiles": "ctd", "IOS_BOT_Profiles": "bottle"}
TIMEOUT = 600
BATCH_SIZE = 200_000
TIME_FMT = "%Y-%m-%dT%H:%M:%SZ"

# Canonical variable → candidate columns in priority order, each with the
# factor to the registry unit (variable_config.yml: `variables` and
# `observed_variables`). µmol/L is mmol/m³; µmol/kg → mmol/m³ uses a nominal
# 1.025 kg/L seawater density.
CANDIDATES: dict[str, list[tuple[str, float]]] = {
    "temperature": [("sea_water_temperature", 1.0), ("TEMPS901", 1.0), ("TEMPST01", 1.0),
                    ("TEMPS601", 1.0), ("TEMPS902", 1.0), ("TEMPS602", 1.0), ("TEMPRTN1", 1.0)],
    "salinity": [("sea_water_practical_salinity", 1.0), ("PSALST01", 1.0), ("PSALBST01", 1.0),
                 ("PSALST02", 1.0)],
    "dissolved_oxygen": [("DOXYZZ01", 44.66), ("DOXMZZ01", 1.025)],
    "nitrate": [("NTRZAAZ1", 1.0)],
    "silicate": [("SLCAAAZ1", 1.0)],
    "phosphate": [("PHOSAAZ1", 1.0)],
    "chlorophyll": [("CPHLFLP1", 1.0)],
}

# Gross range per variable, in the registry unit.
GROSS_RANGE: dict[str, tuple[float, float]] = {
    "temperature": (-2.5, 35.0),
    "salinity": (0.0, 42.0),
    "dissolved_oxygen": (0.0, 600.0),
    "nitrate": (0.0, 60.0),
    "silicate": (0.0, 250.0),
    "phosphate": (0.0, 6.0),
    "chlorophyll": (0.0, 100.0),
}

META = ["profile", "mission_id", "geographic_area", "time", "latitude", "longitude", "depth", "PRESPR01"]


class FetchError(RuntimeError):
    """A period's request failed; its casts are left as they were."""


# ── ERDDAP ────────────────────────────────────────────────────────────────────

def dataset_columns(dataset: str) -> set[str]:
    r = requests.get(f"{ERDDAP}/info/{dataset}/index.csv", timeout=120)
    r.raise_for_status()
    return {row[1] for row in csv.reader(io.StringIO(r.text)) if len(row) > 1 and row[0] == "variable"}


def time_range(dataset: str) -> tuple[datetime, datetime]:
    """First and last cast time, from the server's dataset catalogue
    (an orderByMin over the data itself takes longer than the timeout)."""
    r = requests.get(f'{ERDDAP}/tabledap/allDatasets.csvp?minTime,maxTime&datasetID="{dataset}"', timeout=120)
    r.raise_for_status()
    row = list(csv.reader(io.StringIO(r.text)))[1]
    return tuple(datetime.strptime(v, TIME_FMT).replace(tzinfo=timezone.utc) for v in row)


def fetch_period(dataset: str, columns: list[str], start: datetime, end: datetime) -> list[dict]:
    """Every row with `start <= time < end`. `.csvp` carries units in the header
    instead of a second row (see discover_ios_moorings._csv)."""
    query = (f"{','.join(META + columns)}"
             f"&time>={start.strftime(TIME_FMT)}&time<{end.strftime(TIME_FMT)}")
    try:
        r = requests.get(f"{ERDDAP}/tabledap/{dataset}.csvp?{query}", timeout=TIMEOUT)
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

def _num(raw: str | None) -> float | None:
    if raw in (None, "", "NaN"):
        return None
    try:
        v = float(raw)
    except ValueError:
        return None
    return None if math.isnan(v) else v


def _text(raw: str | None) -> str:
    return "" if raw in (None, "", "None", "NaN") else raw.strip()


def parse_rows(rows: list[dict], dataset: str, candidates: dict[str, list[tuple[str, float]]]):
    """(casts, values): one `ship_casts` row per profile and its long-format
    `ship_cast_values` rows. Rows without a position, time or depth are dropped."""
    kind = DATASETS[dataset]
    meta: dict[str, dict] = {}
    values: dict[str, list] = defaultdict(list)
    for row in rows:
        profile = _text(row.get("profile"))
        # A CTD cast and the bottles fired on it share IOS's profile id, so the
        # id is qualified by kind: "ctd/2024-002-0003", "bottle/2024-002-0003".
        cast_id = f"{kind}/{profile}" if profile else ""
        depth = _num(row.get("depth"))
        lat, lon = _num(row.get("latitude")), _num(row.get("longitude"))
        # A few rows carry only pressure: convert it (TEOS-10, as erddap_to_ch does).
        pressure = _num(row.get("PRESPR01"))
        if depth is None and pressure is not None and lat is not None:
            depth = float(-gsw.z_from_p(pressure, lat))
        if not cast_id or depth is None or lat is None or lon is None or not row.get("time"):
            continue
        try:
            # Aware UTC: clickhouse-connect reads a naive datetime as the
            # client's local time, which shifts every cast off a UTC host.
            t = datetime.strptime(row["time"], TIME_FMT).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if cast_id in meta:
            # Bottles are fired over the cast: it starts at its earliest row.
            meta[cast_id]["time"] = min(meta[cast_id]["time"], t)
        else:
            meta[cast_id] = {
                "cast_id": cast_id, "dataset": dataset, "kind": kind,
                "mission_id": _text(row.get("mission_id")),
                "time": t, "latitude": lat, "longitude": lon,
                "geographic_area": _text(row.get("geographic_area")).replace("-", " "),
            }
        for canonical, options in candidates.items():
            for col, factor in options:
                v = _num(row.get(col))
                if v is None:
                    continue
                v *= factor
                lo, hi = GROSS_RANGE[canonical]
                if lo <= v <= hi:
                    values[cast_id].append([cast_id, canonical, float(depth), float(v)])
                break  # first column with a value wins, in range or not

    casts = []
    for cast_id, m in meta.items():
        vals = values.get(cast_id)
        if not vals:
            continue
        m["max_depth"] = max(v[2] for v in vals)
        m["variables"] = sorted({v[1] for v in vals})
        casts.append(m)
    flat = [v for c in casts for v in values[c["cast_id"]]]
    return casts, flat


# ── ClickHouse ────────────────────────────────────────────────────────────────

CAST_COLS = ["cast_id", "dataset", "kind", "mission_id", "time", "latitude", "longitude",
             "geographic_area", "max_depth", "variables"]
VALUE_COLS = ["cast_id", "variable", "depth", "value"]


def stored_cast_ids(ch_client, cast_ids: set[str]) -> set[str]:
    if not cast_ids:
        return set()
    rows = ch_client.query(
        "SELECT DISTINCT cast_id FROM ship_casts WHERE has({ids:Array(String)}, cast_id)",
        parameters={"ids": sorted(cast_ids)},
    ).result_rows
    return {r[0] for r in rows}


def store(ch_client, casts: list[dict], values: list[list], replace: set[str]):
    if replace:
        ch_client.command(
            "DELETE FROM ship_cast_values WHERE has({ids:Array(String)}, cast_id)",
            parameters={"ids": sorted(replace)},
        )
    for i in range(0, len(values), BATCH_SIZE):
        ch_client.insert("ship_cast_values", values[i:i + BATCH_SIZE], column_names=VALUE_COLS)
    if casts:
        ch_client.insert("ship_casts", [[c[k] for k in CAST_COLS] for c in casts], column_names=CAST_COLS)


# ── Driver ────────────────────────────────────────────────────────────────────

def months(first: datetime, last: datetime):
    y, m = first.year, first.month
    while (y, m) <= (last.year, last.month):
        start = datetime(y, m, 1, tzinfo=timezone.utc)
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
        yield start, datetime(y, m, 1, tzinfo=timezone.utc)


def harvest(dataset: str, since: int | None, until: int | None, force: bool):
    ch_client = get_ch_client()
    have = dataset_columns(dataset)
    candidates = {k: [(c, f) for c, f in v if c in have] for k, v in CANDIDATES.items()}
    candidates = {k: v for k, v in candidates.items() if v}
    columns = sorted({c for v in candidates.values() for c, _ in v})

    first, last = time_range(dataset)
    if since:
        first = max(first, datetime(since, 1, 1, tzinfo=timezone.utc))
    if until:
        last = min(last, datetime(until, 12, 31, tzinfo=timezone.utc))
    print(f"\n{dataset}: {first:%Y-%m} to {last:%Y-%m}  ({', '.join(candidates)})")

    total_casts = total_values = failed = 0
    # A cast's rows can straddle a month boundary (bottles fired around
    # midnight): any profile with a row in a month's last day is held back and
    # parsed with the next month's rows, so it is never stored in halves.
    carry: list[dict] = []
    periods = list(months(first, last))
    for i, (start, end) in enumerate(periods):
        try:
            rows = carry + fetch_period(dataset, columns, start, end)
        except FetchError as e:
            print(f"  {start:%Y-%m}  ERROR {e}")
            failed += 1
            carry = []
            continue
        if i < len(periods) - 1:
            cutoff = (end - timedelta(days=1)).strftime(TIME_FMT)
            tail = {r.get("profile") for r in rows if r.get("time", "") >= cutoff}
            carry = [r for r in rows if r.get("profile") in tail]
            rows = [r for r in rows if r.get("profile") not in tail]
        if not rows:
            continue
        casts, values = parse_rows(rows, dataset, candidates)
        stored = stored_cast_ids(ch_client, {c["cast_id"] for c in casts})
        if force:
            replace = stored & {c["cast_id"] for c in casts}
        else:
            keep = {c["cast_id"] for c in casts} - stored
            casts = [c for c in casts if c["cast_id"] in keep]
            values = [v for v in values if v[0] in keep]
            replace = set()
        store(ch_client, casts, values, replace)
        total_casts += len(casts)
        total_values += len(values)
        print(f"  {start:%Y-%m}  {len(casts):5d} cast(s), {len(values):7d} value(s)")
    print(f"{dataset}: {total_casts} cast(s), {total_values} value(s) stored; {failed} month(s) failed")
    return failed


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="IOS ship casts (CIOOS Pacific ERDDAP) → ClickHouse.")
    p.add_argument("--dataset", action="append", choices=sorted(DATASETS),
                   help="Repeatable; both datasets when omitted.")
    p.add_argument("--year", type=int, help="Only this year (same as --since Y --until Y).")
    p.add_argument("--since", type=int, metavar="YEAR")
    p.add_argument("--until", type=int, metavar="YEAR")
    p.add_argument("--force", action="store_true", help="Replace casts already stored for the period.")
    args = p.parse_args()
    since = args.year or args.since
    until = args.year or args.until
    failures = sum(harvest(d, since, until, args.force) for d in (args.dataset or list(DATASETS)))
    raise SystemExit(1 if failures else 0)
