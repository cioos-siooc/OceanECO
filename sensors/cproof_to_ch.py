"""
cproof_to_ch.py

Fetch C-PROOF glider deployments and store them in ClickHouse
(`glider_deployments` + `glider_profiles`).

Source: C-PROOF's gridded time–depth files, one per deployment, listed in
`mission_all.txt` (which already picks each deployment's best variant:
`_grid` while live, then `_delayed` / `_adjusted` once recovered). C-PROOF
labels them Level 0 — binned, but not QC-screened — so values outside a
gross range are dropped here.

A file is rewritten in place while its mission is live, so a deployment is
re-fetched only when the server's ETag changes, and then replaced wholesale
(profile indices shift when delayed data supersedes real-time).

Usage
-----
    uv run python cproof_to_ch.py --deployment dfo-walle652-20261023
    uv run python cproof_to_ch.py --all
    uv run python cproof_to_ch.py --deployment … --force   # ignore the ETag
"""

import argparse
import math
import os
import re
import tempfile
from datetime import datetime, timedelta, timezone

import netCDF4
import numpy as np
import requests

from ch_helpers import get_ch_client

INDEX_URL = "https://cproof.uvic.ca/gliderdata/deployments/mission_all.txt"
BATCH_SIZE = 100_000

# Source variable → (registry id, factor to the registry unit, gross range in
# the registry unit). µmol/L is mmol/m³, so oxygen needs no factor. Salinity is
# stored as PSU, as every other sensor's is (TEOS-10 conversion is deferred).
VARIABLES = {
    "temperature":          ("temperature",      1.0, (-2.5, 35.0)),
    "salinity":             ("salinity",         1.0, (0.0, 42.0)),
    "oxygen_concentration": ("dissolved_oxygen", 1.0, (0.0, 600.0)),
}

# A deployment counts as live while it is still the plain real-time `_grid`
# variant and its last profile is recent.
LIVE_WINDOW = timedelta(days=3)

_URL_RE = re.compile(r"/(?P<glider>[^/]+)/(?P<deployment>[^/]+)/L0-gridfiles/(?P<file>[^/]+\.nc)$")


class FetchError(RuntimeError):
    """The deployment's file could not be fetched; its rows are left as they were."""


# ── Index ─────────────────────────────────────────────────────────────────────

def parse_index_url(url: str) -> dict | None:
    m = _URL_RE.search(url)
    if not m:
        return None
    stem = m["file"][:-3]
    variant = stem.split("_grid", 1)[1].lstrip("_") if "_grid" in stem else ""
    return {
        "url": url.replace("/./", "/"),
        "glider": m["glider"],
        "deployment_id": m["deployment"],
        "variant": variant or "grid",
    }


def fetch_index() -> list[dict]:
    r = requests.get(INDEX_URL, timeout=60)
    r.raise_for_status()
    entries = [parse_index_url(line.strip()) for line in r.text.splitlines() if line.strip()]
    return [e for e in entries if e]


# ── CH helpers ────────────────────────────────────────────────────────────────

def stored_etag(ch_client, deployment_id: str) -> str | None:
    rows = ch_client.query(
        "SELECT etag FROM glider_deployments FINAL WHERE deployment_id = {d:String}",
        parameters={"d": deployment_id},
    ).result_rows
    return rows[0][0] if rows else None


def replace_profiles(ch_client, deployment_id: str, rows: list):
    ch_client.command(
        "DELETE FROM glider_profiles WHERE deployment_id = {d:String}",
        parameters={"d": deployment_id},
    )
    for start in range(0, len(rows), BATCH_SIZE):
        ch_client.insert(
            "glider_profiles",
            rows[start:start + BATCH_SIZE],
            column_names=["deployment_id", "profile", "time", "latitude", "longitude",
                          "variable", "depth", "value"],
        )


def upsert_deployment(ch_client, meta: dict):
    cols = list(meta.keys())
    ch_client.insert("glider_deployments", [[meta[c] for c in cols]], column_names=cols)


# ── File parsing ──────────────────────────────────────────────────────────────

def _attr(ds, name: str, default: str = "") -> str:
    return str(getattr(ds, name, default))


def _valid_position(lat: float, lon: float) -> bool:
    # A few early files carry positions in radians; drop those profiles.
    return (math.isfinite(lat) and math.isfinite(lon)
            and 30.0 <= lat <= 70.0 and -180.0 <= lon <= -100.0)


def parse_grid_file(path: str, deployment_id: str) -> tuple[list, dict]:
    """Return (profile rows, deployment metadata) for one grid file."""
    with netCDF4.Dataset(path) as ds:
        depth = np.asarray(ds["depth"][:], dtype=float)
        tvar = ds["time"]
        times = netCDF4.num2date(tvar[:], tvar.units, only_use_cftime_datetimes=False,
                                 only_use_python_datetimes=True)
        times = np.ma.filled(np.ma.asarray(times, dtype=object), None)
        lat = np.ma.filled(np.ma.asarray(ds["latitude"][:], dtype=float), np.nan)
        lon = np.ma.filled(np.ma.asarray(ds["longitude"][:], dtype=float), np.nan)

        keep = [i for i, t in enumerate(times)
                if t is not None and t.year > 1970 and _valid_position(lat[i], lon[i])]

        rows = []
        for src, (canonical, factor, (lo, hi)) in VARIABLES.items():
            if src not in ds.variables:
                continue
            grid = np.ma.filled(np.ma.asarray(ds[src][:], dtype=float), np.nan) * factor
            if ds[src].dimensions[0] != "depth":
                grid = grid.T
            for i in keep:
                col = grid[:, i]
                ok = np.isfinite(col) & (col >= lo) & (col <= hi)
                t = times[i].replace(tzinfo=None)
                for k in np.flatnonzero(ok):
                    rows.append([deployment_id, i, t, float(lat[i]), float(lon[i]),
                                 canonical, float(depth[k]), float(col[k])])

        kept_lat, kept_lon = lat[keep], lon[keep]
        kept_t = [times[i].replace(tzinfo=None) for i in keep]
        meta = {
            "platform_type": _attr(ds, "platform_type"),
            "summary": _attr(ds, "summary"),
            "station": _attr(ds, "deployment_station"),
            "start_time": min(kept_t) if kept_t else datetime(1970, 1, 1),
            "end_time": max(kept_t) if kept_t else datetime(1970, 1, 1),
            "lat_min": float(np.min(kept_lat)) if keep else 0.0,
            "lat_max": float(np.max(kept_lat)) if keep else 0.0,
            "lon_min": float(np.min(kept_lon)) if keep else 0.0,
            "lon_max": float(np.max(kept_lon)) if keep else 0.0,
            "profiles": len(keep),
        }
    return rows, meta


# ── Main fetch loop ───────────────────────────────────────────────────────────

def store_deployment(ch_client, entry: dict, force: bool = False) -> bool:
    """Fetch one deployment if its file changed and replace its rows.
    Returns True when it was (re)stored. Raises FetchError on a failed download."""
    dep = entry["deployment_id"]
    try:
        head = requests.head(entry["url"], timeout=60, allow_redirects=True)
        head.raise_for_status()
    except requests.RequestException as e:
        raise FetchError(f"{dep}: {e}") from e
    etag = head.headers.get("ETag", "") + head.headers.get("Last-Modified", "")

    if not force and etag and stored_etag(ch_client, dep) == etag:
        print(f"{dep}: unchanged")
        return False

    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "grid.nc")
        try:
            with requests.get(entry["url"], timeout=300, stream=True) as r:
                r.raise_for_status()
                with open(path, "wb") as f:
                    for chunk in r.iter_content(1 << 20):
                        f.write(chunk)
        except requests.RequestException as e:
            raise FetchError(f"{dep}: {e}") from e
        rows, meta = parse_grid_file(path, dep)

    live = entry["variant"] == "grid" and meta["profiles"] > 0 and \
        datetime.now(timezone.utc).replace(tzinfo=None) - meta["end_time"] < LIVE_WINDOW
    replace_profiles(ch_client, dep, rows)
    upsert_deployment(ch_client, {
        "deployment_id": dep,
        "glider": entry["glider"],
        **meta,
        "file_url": entry["url"],
        "variant": entry["variant"],
        "etag": etag,
        "active": int(live),
    })
    print(f"{dep} ({entry['variant']}): {meta['profiles']} profile(s), {len(rows)} row(s)"
          f"{' — live' if live else ''}")
    return True


def fetch_and_store(deployments: list[str] | None = None, force: bool = False):
    ch_client = get_ch_client()
    entries = fetch_index()
    if deployments:
        wanted = set(deployments)
        entries = [e for e in entries if e["deployment_id"] in wanted]
        missing = wanted - {e["deployment_id"] for e in entries}
        if missing:
            print(f"Not in the C-PROOF index: {', '.join(sorted(missing))}")

    for entry in entries:
        try:
            store_deployment(ch_client, entry, force=force)
        except FetchError as e:
            print(f"  ERROR: {e}")

    print("\nDone.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Fetch C-PROOF glider deployments → ClickHouse.")
    which = parser.add_mutually_exclusive_group(required=True)
    which.add_argument("--deployment", action="append", metavar="ID",
                       help="Deployment id, e.g. dfo-walle652-20261023 (repeatable).")
    which.add_argument("--all", action="store_true", help="Every deployment in the index.")
    parser.add_argument("--force", action="store_true", help="Re-fetch even if the ETag is unchanged.")
    args = parser.parse_args()
    fetch_and_store(deployments=None if args.all else args.deployment, force=args.force)
