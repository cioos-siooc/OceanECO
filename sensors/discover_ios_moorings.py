"""
discover_ios_moorings.py

Generate `catalog_ios.yml` from CIOOS Pacific's IOS_CTD_Moorings dataset:
one sensor per instrument deployment (one IOS `.ctd` file = one instrument
at one depth for one deployment), with its exact position and depth.

Nothing is merged here. A site is redeployed every few months, often a few
hundred metres from the last position and at a slightly different depth;
those deployments are joined at display time instead, with a user-adjustable
distance/depth tolerance (front/app/utils/sensorMerge.ts). `source.site`
carries the IOS station code from the filename (A1, E01, …) as a label for
a merged group.

The files hold different column sets: temperature is `sea_water_temperature`
(ITS-90) in about half of them and `TEMPST01` in the rest; salinity is
`sea_water_practical_salinity` or `PSALST01`; oxygen is `DOXYZZ01` (mL/L) or,
in a few, `DOXMZZ01` (µmol/kg). Each deployment gets the first column of its
variable that actually has data in that file.

Every entry is `archive: true`: the files are delayed-mode and don't change,
so the hourly harvest skips a deployment once it holds data
(erddap_to_ch.get_active_erddap_sensors).

Usage
-----
    uv run python discover_ios_moorings.py > catalog_ios.yml
    uv run python manage_sensors.py import --file catalog_ios.yml
    uv run python erddap_to_ch.py      # first harvest (archive sensors without data are included)
"""

from __future__ import annotations

import csv
import io
import re
import sys
from datetime import datetime

import requests
import yaml

ERDDAP = "https://data.cioospacific.ca/erddap/tabledap/IOS_CTD_Moorings"
TIMEOUT = 300

# Canonical variable → candidate columns in priority order, each with its
# source unit and the factor to the registry unit (variable_config.yml).
# µmol/kg → mmol/m³ uses a nominal 1.025 kg/L seawater density.
CANDIDATES: dict[str, list[tuple[str, str, float]]] = {
    "temperature": [
        ("sea_water_temperature", "C", 1.0),
        ("TEMPST01", "C", 1.0),
    ],
    "salinity": [
        ("sea_water_practical_salinity", "PSU", 1.0),
        ("PSALST01", "PSU", 1.0),
    ],
    "dissolved_oxygen": [
        ("DOXYZZ01", "ml/L", 44.66),
        ("DOXMZZ01", "umol/kg", 1.025),
    ],
}


def _csv(query: str) -> list[dict]:
    """Rows of a tabledap query; [] when ERDDAP finds none.

    `.csvp` puts units in the header ("time (UTC)") instead of a second row:
    plain `.csv`'s units row is blank for a unitless single-column query, and
    csv skips blank lines, so dropping "the units row" would drop real data."""
    r = requests.get(f"{ERDDAP}.csvp?{query}", timeout=TIMEOUT)
    if r.status_code == 404:
        return []
    r.raise_for_status()
    reader = csv.reader(io.StringIO(r.text))
    header = [re.sub(r" \(.*\)$", "", h) for h in next(reader)]
    return [dict(zip(header, row)) for row in reader]


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def discover() -> list[dict]:
    _log("Listing deployments…")
    meta = _csv("filename,latitude,longitude,instrument_depth,geographic_area,project&distinct()")
    _log(f"  {len(meta)} deployment(s)")

    _log("Time ranges…")
    span: dict[str, list[str]] = {}
    for row in _csv('filename,time&orderByMinMax("filename,time")'):
        span.setdefault(row["filename"], []).append(row["time"])

    has: dict[str, set[str]] = {}
    for options in CANDIDATES.values():
        for col, _, _ in options:
            _log(f"Files with {col}…")
            has[col] = {r["filename"] for r in _csv(f"filename&{col}!=NaN&distinct()")}

    entries: list[dict] = []
    names: set[str] = set()
    for row in sorted(meta, key=lambda r: r["filename"].lower()):
        fn = row["filename"]
        times = sorted(span.get(fn, []))
        if not times:
            continue
        variables = {}
        for canonical, options in CANDIDATES.items():
            for col, unit, factor in options:
                if fn in has[col]:
                    variables[canonical] = {"code": col, "unit": unit, "factor": factor}
                    break
        if not variables:
            continue

        site = re.split(r"[-_ ]", fn, maxsplit=1)[0].upper()
        depth = float(row["instrument_depth"])
        start = datetime.strptime(times[0], "%Y-%m-%dT%H:%M:%SZ")
        end = datetime.strptime(times[-1], "%Y-%m-%dT%H:%M:%SZ")
        name = f"IOS {site} {depth:g} m {start:%Y-%m}"
        if name in names:
            name = f"{name} ({fn})"
        names.add(name)

        area = row["geographic_area"].replace("-", " ") if row["geographic_area"] not in ("", "None") else ""
        project = row["project"] if row["project"] not in ("", "None") else ""
        entries.append({
            "name": name,
            "lat": round(float(row["latitude"]), 5),
            "lon": round(float(row["longitude"]), 5),
            "depth": depth,
            "api": "ERDDAP",
            "organization": "DFO IOS",
            "archive": True,
            "site": site,
            "source_link": ERDDAP,
            "constraints": f'filename="{fn}"',
            "description": " · ".join(p for p in (
                project, area, f"{start:%Y-%m-%d} to {end:%Y-%m-%d}", fn) if p),
            "variables": variables,
        })
    return entries


HEADER = """\
# DFO Institute of Ocean Sciences — moored CTDs (CIOOS Pacific IOS_CTD_Moorings)
#
# Generated by discover_ios_moorings.py; regenerate rather than hand-edit.
# One sensor per instrument deployment (one IOS .ctd file), at its exact
# position and depth. Redeployments of a site are joined at display time,
# not here. All entries are archive: true (delayed-mode files that don't
# change), so the hourly harvest skips them once they hold data.
#
#   uv run python manage_sensors.py import --file catalog_ios.yml
#   uv run python erddap_to_ch.py   # harvests archive sensors that hold no data yet
"""


if __name__ == "__main__":
    found = discover()
    _log(f"{len(found)} sensor(s) written")
    sys.stdout.write(HEADER)
    yaml.safe_dump({"sensors": found}, sys.stdout, sort_keys=False, allow_unicode=True, width=200)
