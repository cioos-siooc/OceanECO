"""Admin dashboard API (`/manage/*`), used by the frontend's /admin page.

Kept off `/admin/*` so the Cloudflare Access app guarding these routes doesn't
also catch `/admin/syncHourly` + `/admin/syncDaily`, which PROCESS calls with a
bearer token.

Auth: Cloudflare Access sits in front and logs people in with a one-time PIN
sent to an allowlisted email. Every request here must carry the
`Cf-Access-Jwt-Assertion` header Access adds; we verify it against the team's
public keys and our app's audience tag, and the email in it signs the audit
log. In dev (no `CF_ACCESS_AUD`) `ADMIN_DEV_EMAIL` stands in.

Writes also need an unlocked session: `POST /manage/unlock` opens a 15-minute
window, extended by every applied change. The UI greys out controls, but this
check is what actually refuses a locked write.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from modules import response_cache
from modules.clickhouse_helpers import get_ch_client

logger = logging.getLogger(__name__)

CF_ACCESS_TEAM_DOMAIN = os.getenv("CF_ACCESS_TEAM_DOMAIN", "")  # e.g. cioospacific.cloudflareaccess.com
CF_ACCESS_AUD = os.getenv("CF_ACCESS_AUD", "")
ADMIN_DEV_EMAIL = os.getenv("ADMIN_DEV_EMAIL", "")
# Second guard behind the Access policy: if set, only these emails get in.
ADMIN_EMAILS = {e.strip().lower() for e in os.getenv("ADMIN_EMAILS", "").split(",") if e.strip()}
# Browser origins allowed to call /manage (the CORS middleware reflects any origin).
ADMIN_ORIGINS = {o.strip().rstrip("/") for o in os.getenv("ADMIN_ORIGINS", "http://localhost:9010").split(",") if o.strip()}
PREFECT_API_URL = os.getenv("PREFECT_API_URL", "").rstrip("/")
PREFECT_AUTH_STRING = os.getenv("PREFECT_API_AUTH_STRING", "")

UNLOCK_SECONDS = 15 * 60

# Prefect deployments the dashboard shows, as (flow name, deployment name).
# The model pipeline is shown but not controllable: it's run from PROCESS, not from here.
JOBS = {
    "OceanECO-sensors-ERDDAP": ("oceaneco-sensors-erddap", "Hakai, UW and IOS sensors → sensor_timeseries", True),
    "OceanECO-sensors-ONC": ("oceaneco-sensors-onc", "ONC sensors → sensor_timeseries", True),
    "OceanECO-SSC": ("oceaneco-ssc-pipeline", "SalishSeaCast: download → compute → image → ingest → sync", False),
}

SENSOR_FIELDS = ("active", "auto_harvest", "name", "organization", "depth", "note", "variables")

router = APIRouter()


# ── Schema ────────────────────────────────────────────────────────────────────

_DDL = [
    "ALTER TABLE sensors ADD COLUMN IF NOT EXISTS auto_harvest Bool DEFAULT true",
    "ALTER TABLE sensors ADD COLUMN IF NOT EXISTS note String DEFAULT ''",
    """CREATE TABLE IF NOT EXISTS admin_audit (
        id        UUID DEFAULT generateUUIDv4(),
        at        DateTime64(3) DEFAULT now64(3),
        email     String,
        kind      LowCardinality(String),
        target    String,
        label     String,
        field     String,
        before    String,
        after     String,
        summary   String
    ) ENGINE = MergeTree ORDER BY at""",
]

_schema_ready = False


def _client():
    global _schema_ready
    client = get_ch_client()
    if not _schema_ready:
        for ddl in _DDL:
            client.command(ddl)
        _schema_ready = True
    return client


# ── Auth ──────────────────────────────────────────────────────────────────────

_jwks_client = None


def _verify_access_jwt(token: str) -> str:
    global _jwks_client
    import jwt  # PyJWT

    if _jwks_client is None:
        _jwks_client = jwt.PyJWKClient(f"https://{CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs", cache_keys=True)
    key = _jwks_client.get_signing_key_from_jwt(token).key
    claims = jwt.decode(token, key, algorithms=["RS256"], audience=CF_ACCESS_AUD,
                        issuer=f"https://{CF_ACCESS_TEAM_DOMAIN}")
    return str(claims.get("email", "")).lower()


def admin_email(request: Request, cf_access_jwt_assertion: Optional[str] = Header(None)) -> str:
    origin = request.headers.get("origin")
    if origin and origin.rstrip("/") not in ADMIN_ORIGINS:
        raise HTTPException(403, "Origin not allowed")
    if CF_ACCESS_AUD:
        if not CF_ACCESS_TEAM_DOMAIN or not cf_access_jwt_assertion:
            raise HTTPException(401, "Not signed in")
        try:
            email = _verify_access_jwt(cf_access_jwt_assertion)
        except Exception as exc:
            logger.warning("Rejected Access token: %s", exc)
            raise HTTPException(401, "Not signed in")
    elif ADMIN_DEV_EMAIL:
        email = ADMIN_DEV_EMAIL.lower()
    else:
        raise HTTPException(503, "Admin sign-in isn't configured (set CF_ACCESS_AUD, or ADMIN_DEV_EMAIL in dev)")
    if not email or (ADMIN_EMAILS and email not in ADMIN_EMAILS):
        raise HTTPException(403, "This email isn't an admin")
    return email


# shortcut: in-memory, so it assumes one uvicorn worker (api/Dockerfile runs one) and a
# restart relocks everyone; move to a ClickHouse row if the API ever runs several workers.
_unlocked_until: dict[str, float] = {}


def _unlock_left(email: str) -> float:
    return max(0.0, _unlocked_until.get(email, 0.0) - time.time())


def unlocked_email(email: str = Depends(admin_email)) -> str:
    if _unlock_left(email) <= 0:
        raise HTTPException(423, "Editing is locked. Unlock it first.")
    return email


@router.get("/login")
def login(next: str = "", email: str = Depends(admin_email)):
    """Top-level navigation target: Access logs the user in on the way here, then we send them back."""
    parsed = urllib.parse.urlparse(next)
    if f"{parsed.scheme}://{parsed.netloc}" not in ADMIN_ORIGINS:
        raise HTTPException(400, "next must be an allowed admin origin")
    return RedirectResponse(next, status_code=303)


@router.get("/me")
def me(email: str = Depends(admin_email)):
    return {"email": email, "unlockedFor": round(_unlock_left(email)),
            "prefect": bool(PREFECT_API_URL), "logoutPath": "/cdn-cgi/access/logout" if CF_ACCESS_AUD else None}


@router.post("/unlock")
def unlock(email: str = Depends(admin_email)):
    _unlocked_until[email] = time.time() + UNLOCK_SECONDS
    return {"unlockedFor": UNLOCK_SECONDS}


@router.post("/lock")
def lock(email: str = Depends(admin_email)):
    _unlocked_until.pop(email, None)
    return {"unlockedFor": 0}


# ── Audit ─────────────────────────────────────────────────────────────────────

def _audit(client, email: str, kind: str, target: str, label: str, field: str,
           before: Any, after: Any, summary: str) -> None:
    client.insert("admin_audit", [[email, kind, target, label, field,
                                   json.dumps(before), json.dumps(after), summary]],
                  column_names=["email", "kind", "target", "label", "field", "before", "after", "summary"])


@router.get("/audit")
async def audit(limit: int = 200, email: str = Depends(admin_email)):
    def _q():
        rows = _client().query(
            "SELECT id, at, email, kind, target, label, field, before, after, summary "
            "FROM admin_audit ORDER BY at DESC LIMIT {limit:UInt32}", parameters={"limit": min(limit, 2000)},
        ).named_results()
        return [{**r, "id": str(r["id"]), "at": r["at"].isoformat() + "Z",
                 "before": json.loads(r["before"]), "after": json.loads(r["after"])} for r in rows]
    return await run_in_threadpool(_q)


# ── Sensors ───────────────────────────────────────────────────────────────────

_coverage_cache: tuple[float, dict] = (0.0, {})


def _coverage(client) -> dict[str, dict]:
    """Per sensor: {variable: [first, last, rows]}. One pass over sensor_timeseries, cached 2 min."""
    global _coverage_cache
    if time.time() - _coverage_cache[0] < 120:
        return _coverage_cache[1]
    out: dict[str, dict] = {}
    for sid, var, t0, t1, n in client.query(
        "SELECT sensor_id, variable, min(time), max(time), count() FROM sensor_timeseries GROUP BY sensor_id, variable"
    ).result_rows:
        out.setdefault(str(sid), {})[var] = [t0.isoformat() + "Z", t1.isoformat() + "Z", n]
    _coverage_cache = (time.time(), out)
    return out


def _sensor_row(client, sensor_id: str) -> dict:
    res = client.query("SELECT * FROM sensors FINAL WHERE id = {id:UUID}", parameters={"id": sensor_id})
    rows = list(res.named_results())
    if not rows:
        raise HTTPException(404, "No such sensor")
    return rows[0]


def _public_sensor(row: dict, coverage: dict) -> dict:
    source = json.loads(row["source"] or "{}")
    return {
        "id": str(row["id"]), "name": row["name"], "organization": row["organization"],
        "latitude": row["latitude"], "longitude": row["longitude"], "depth": float(row["depth"]),
        "active": bool(row["active"]), "auto_harvest": bool(row.get("auto_harvest", True)), "note": row.get("note", ""),
        "api": source.get("api", ""), "source": source, "variables": json.loads(row["variables"] or "{}"),
        "coverage": coverage.get(str(row["id"]), {}),
        "updated_at": row["updated_at"].isoformat() + "Z",
    }


@router.get("/sensors")
async def list_sensors(email: str = Depends(admin_email)):
    def _q():
        client = _client()
        cov = _coverage(client)
        return [_public_sensor(r, cov) for r in client.query("SELECT * FROM sensors FINAL ORDER BY name").named_results()]
    return await run_in_threadpool(_q)


def _validate_sensor_field(field: str, value: Any) -> Any:
    if field in ("active", "auto_harvest"):
        if not isinstance(value, bool):
            raise HTTPException(400, f"{field} is on or off")
        return value
    if field == "name":
        if not isinstance(value, str) or not value.strip() or len(value) > 200:
            raise HTTPException(400, "Name must be 1–200 characters")
        return value.strip()
    if field in ("organization", "note"):
        if not isinstance(value, str) or len(value) > 500:
            raise HTTPException(400, f"{field} must be text under 500 characters")
        return value.strip()
    if field == "depth":
        try:
            return float(value)
        except (TypeError, ValueError):
            raise HTTPException(400, "Depth must be a number of metres (-1 for a profiler)")
    if field == "variables":
        if not isinstance(value, dict) or not value:
            raise HTTPException(400, "Variables must map app variables to their source")
        for canonical, spec in value.items():
            if not isinstance(spec, dict):
                raise HTTPException(400, f"Bad mapping for {canonical}")
            try:
                float(spec.get("conversion_factor", 1))
            except (TypeError, ValueError):
                raise HTTPException(400, f"Conversion factor for {canonical} must be a number")
        return json.dumps(value)
    raise HTTPException(400, f"{field} can't be edited here")


def _write_sensor(client, row: dict) -> None:
    row = {**row, "updated_at": datetime.now(timezone.utc).replace(tzinfo=None)}
    client.insert("sensors", [list(row.values())], column_names=list(row.keys()))


def _decode_field(field: str, stored: Any) -> Any:
    if field in ("active", "auto_harvest"):
        return bool(stored)
    if field == "variables":
        return json.loads(stored or "{}")
    if field == "depth":
        return float(stored)
    return stored


# ── Apply staged changes ──────────────────────────────────────────────────────

class Change(BaseModel):
    kind: Literal["sensor", "sensor_new"]
    id: Optional[str] = None          # sensor id
    field: Optional[str] = None       # sensor field
    value: Any = None
    summary: str = ""


class ApplyRequest(BaseModel):
    changes: list[Change]


def _apply_one(client, email: str, ch: Change) -> None:
    if ch.kind == "sensor":
        if ch.field not in SENSOR_FIELDS or not ch.id:
            raise HTTPException(400, f"Can't change sensor field {ch.field!r}")
        row = _sensor_row(client, ch.id)
        new = _validate_sensor_field(ch.field, ch.value)
        before = _decode_field(ch.field, row[ch.field])
        row[ch.field] = new
        _write_sensor(client, row)
        _audit(client, email, "sensor", ch.id, row["name"], ch.field, before, _decode_field(ch.field, new),
               ch.summary or f"{ch.field} changed")
    else:
        row = _new_sensor_row(client, ch.value)
        _write_sensor(client, row)
        _audit(client, email, "sensor_new", str(row["id"]), row["name"], "", None,
               {k: row[k] for k in ("name", "organization", "latitude", "longitude", "depth", "active", "auto_harvest")},
               ch.summary or "Added sensor")


@router.post("/apply")
async def apply(req: ApplyRequest, email: str = Depends(unlocked_email)):
    if not req.changes or len(req.changes) > 1000:
        raise HTTPException(400, "Send 1–1000 changes")

    def _run():
        client = _client()
        for ch in req.changes:
            _apply_one(client, email, ch)
    # Validation errors stop at the change that failed; earlier ones are already written and audited.
    await run_in_threadpool(_run)
    response_cache.invalidate_all()
    _unlocked_until[email] = time.time() + UNLOCK_SECONDS
    return {"applied": len(req.changes), "unlockedFor": UNLOCK_SECONDS}


@router.post("/undo/{audit_id}")
async def undo(audit_id: str, email: str = Depends(unlocked_email)):
    def _run():
        client = _client()
        rows = list(client.query("SELECT * FROM admin_audit WHERE id = {id:UUID}",
                                 parameters={"id": audit_id}).named_results())
        if not rows:
            raise HTTPException(404, "No such audit entry")
        a = rows[0]
        if a["kind"] != "sensor":
            raise HTTPException(400, "Only sensor changes can be undone")
        ch = Change(kind="sensor", id=a["target"], field=a["field"],
                    value=json.loads(a["before"]), summary=f"Undo: {a['summary']}")
        _apply_one(client, email, ch)
    await run_in_threadpool(_run)
    response_cache.invalidate_all()
    return {"ok": True}


# ── Add sensor ────────────────────────────────────────────────────────────────

def _sensors_lib():
    """The harvester package's discovery helpers (sensors/), mounted or copied next to the API."""
    path = os.getenv("SENSORS_LIB", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "sensors"))
    if path not in sys.path:
        sys.path.insert(0, path)


class LookupRequest(BaseModel):
    type: Literal["erddap", "onc"]
    source: str               # tabledap URL, or ONC location code
    constraints: str = ""     # ERDDAP row filter, e.g. STN_ID="C46146"


@router.post("/sensors/lookup")
async def lookup(req: LookupRequest, email: str = Depends(admin_email)):
    """Read the source's metadata only and propose a sensor; nothing is written."""
    def _run():
        import yaml
        _sensors_lib()
        if req.type == "erddap":
            from discover_erddap import discover_one
            parsed = urllib.parse.urlparse(req.source.strip())
            parts = parsed.path.rstrip("/").split("/")
            if parsed.scheme not in ("http", "https") or "tabledap" not in parts or parts[-1] == "tabledap":
                raise HTTPException(400, "Give a tabledap dataset URL, like https://…/erddap/tabledap/DatasetID")
            i = parts.index("tabledap")
            base = f"{parsed.scheme}://{parsed.netloc}{'/'.join(parts[:i])}"
            dataset = parts[i + 1].removesuffix(".html")
            text = discover_one(base, dataset, show_unmapped=False)
        else:
            from discover_location import discover
            code = req.source.strip()
            if not code.replace("-", "").replace(".", "").isalnum():
                raise HTTPException(400, "Give an ONC location code, like SCVIP")
            text = discover(code)
        entries = yaml.safe_load(text) or []
        if not entries:
            raise HTTPException(404, text.strip().lstrip("# ") or "Nothing found")
        entry = entries[0]
        if req.constraints.strip():
            entry["constraints"] = req.constraints.strip()
        from manage_sensors import catalog_variables
        try:
            variables, device_config = catalog_variables(entry)
        except ValueError as exc:
            raise HTTPException(422, f"Found the source, but its variables don't map: {exc}")
        source = {"api": entry["api"]}
        for k_in, k_out in (("source_link", "link"), ("description", "description"), ("constraints", "constraints")):
            if entry.get(k_in):
                source[k_out] = entry[k_in]
        link, constraints = source.get("link", ""), source.get("constraints", "")
        def same(src: dict, dev: dict) -> bool:
            if req.type == "erddap":
                return src.get("link") == link and src.get("constraints", "") == constraints
            return src.get("api") == "ONC" and dev.get("locationCode") == device_config.get("locationCode")
        dupes = [name for name, src, dev in _client().query(
            "SELECT name, source, device_config FROM sensors FINAL").result_rows
            if same(json.loads(src or "{}"), json.loads(dev or "{}"))]
        return {"name": entry["name"], "organization": entry.get("organization") or "",
                "latitude": float(entry["lat"]), "longitude": float(entry["lon"]), "depth": float(entry["depth"]),
                "variables": variables, "device_config": device_config, "source": source, "duplicates": dupes}
    return await run_in_threadpool(_run)


def _new_sensor_row(client, v: Any) -> dict:
    if not isinstance(v, dict):
        raise HTTPException(400, "New sensor needs its looked-up fields")
    try:
        lat, lon = float(v["latitude"]), float(v["longitude"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(400, "New sensor needs a latitude and longitude")
    source = v.get("source")
    if not isinstance(source, dict) or source.get("api") not in ("ERDDAP", "ONC"):
        raise HTTPException(400, "New sensor's source must be ERDDAP or ONC")
    cols = [r[0] for r in client.query("DESCRIBE TABLE sensors").result_rows]
    row = {c: None for c in cols}
    row.update({
        "id": uuid.uuid4(),
        "name": _validate_sensor_field("name", v.get("name")),
        "organization": _validate_sensor_field("organization", v.get("organization", "")),
        "note": _validate_sensor_field("note", v.get("note", "")),
        "latitude": lat, "longitude": lon,
        "depth": _validate_sensor_field("depth", v.get("depth", 0)),
        "variables": _validate_sensor_field("variables", v.get("variables")),
        "device_config": json.dumps(v.get("device_config") or {}),
        "source": json.dumps(source),
        "active": _validate_sensor_field("active", bool(v.get("active", True))),
        "auto_harvest": _validate_sensor_field("auto_harvest", bool(v.get("auto_harvest", True))),
    })
    row.pop("updated_at", None)
    return {k: val for k, val in row.items() if val is not None}


# ── Destructive sensor actions ────────────────────────────────────────────────

class Confirm(BaseModel):
    confirm: str


@router.post("/sensors/{sensor_id}/delete-data")
async def delete_sensor_data(sensor_id: str, req: Confirm, email: str = Depends(unlocked_email)):
    """Remove a sensor's rows from sensor_timeseries and hide it. Not undoable; a harvest refills it."""
    def _run():
        client = _client()
        row = _sensor_row(client, sensor_id)
        if req.confirm.strip() != row["name"]:
            raise HTTPException(400, "Type the sensor's name exactly to confirm")
        client.command("ALTER TABLE sensor_timeseries DELETE WHERE sensor_id = {id:UUID}",
                       parameters={"id": sensor_id})
        was_active = bool(row["active"])
        row["active"] = False
        _write_sensor(client, row)
        _audit(client, email, "sensor_data", sensor_id, row["name"], "data", "kept", "deleted",
               "Deleted all measurements" + (" and hid the sensor" if was_active else ""))
        global _coverage_cache
        _coverage_cache = (0.0, {})
    await run_in_threadpool(_run)
    response_cache.invalidate_all()
    return {"ok": True}


# ── Prefect jobs ──────────────────────────────────────────────────────────────

def _prefect(method: str, path: str, body: Any = None) -> Any:
    if not PREFECT_API_URL:
        raise HTTPException(503, "PREFECT_API_URL isn't set on this API")
    req = urllib.request.Request(f"{PREFECT_API_URL}{path}", method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    if PREFECT_AUTH_STRING:
        req.add_header("Authorization", "Basic " + base64.b64encode(PREFECT_AUTH_STRING.encode()).decode())
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as exc:
        raise HTTPException(502, f"Prefect answered {exc.code}: {exc.read()[:300].decode(errors='replace')}")
    except urllib.error.URLError as exc:
        raise HTTPException(502, f"Can't reach Prefect: {exc.reason}")


def _deployment(name: str) -> dict:
    if name not in JOBS:
        raise HTTPException(404, "Unknown job")
    return _prefect("GET", f"/deployments/name/{JOBS[name][0]}/{name}")


def _run_summary(run: dict | None) -> dict | None:
    if not run:
        return None
    state = run.get("state") or {}
    return {"id": run["id"], "state": state.get("type"), "name": state.get("name"),
            "start": run.get("start_time") or run.get("expected_start_time"), "end": run.get("end_time"),
            "seconds": run.get("total_run_time"), "message": state.get("message")}


@router.get("/jobs")
async def jobs(email: str = Depends(admin_email)):
    if not PREFECT_API_URL:
        return {"configured": False, "jobs": []}

    def _run():
        out = []
        ui = PREFECT_API_URL.removesuffix("/api")
        for name, (_, what, controllable) in JOBS.items():
            try:
                d = _deployment(name)
            except HTTPException as exc:
                out.append({"name": name, "what": what, "controllable": controllable, "error": exc.detail})
                continue
            flt = {"deployments": {"id": {"any_": [d["id"]]}}}
            last = _prefect("POST", "/flow_runs/filter", {
                "flow_runs": {"state": {"type": {"not_any_": ["SCHEDULED"]}}}, **flt,
                "sort": "EXPECTED_START_TIME_DESC", "limit": 1})
            nxt = _prefect("POST", "/flow_runs/filter", {
                "flow_runs": {"state": {"type": {"any_": ["SCHEDULED"]}}}, **flt,
                "sort": "EXPECTED_START_TIME_ASC", "limit": 1})
            crons = [s.get("schedule", {}).get("cron") for s in d.get("schedules") or []]
            out.append({"name": name, "what": what, "id": d["id"], "paused": bool(d.get("paused")),
                        "controllable": controllable,
                        "cron": next((c for c in crons if c), None),
                        "last": _run_summary(last[0] if last else None),
                        "next": (nxt[0].get("expected_start_time") if nxt else None),
                        "url": f"{ui}/deployments/deployment/{d['id']}"})
        return {"configured": True, "jobs": out}
    return await run_in_threadpool(_run)


class JobAction(BaseModel):
    action: Literal["run", "pause", "resume"]


@router.post("/jobs/{name}")
async def job_action(name: str, req: JobAction, email: str = Depends(unlocked_email)):
    if name in JOBS and not JOBS[name][2]:
        raise HTTPException(400, f"{name} is shown here but run from PROCESS")

    def _run():
        d = _deployment(name)
        if req.action == "run":
            run = _prefect("POST", f"/deployments/{d['id']}/create_flow_run", {})
            summary, after = "Started a run", run.get("id")
        else:
            _prefect("PATCH", f"/deployments/{d['id']}", {"paused": req.action == "pause"})
            summary, after = ("Paused the schedule" if req.action == "pause" else "Resumed the schedule"), req.action
        _audit(_client(), email, "job", name, name, req.action, None, after, summary)
    await run_in_threadpool(_run)
    return {"ok": True}


@router.post("/sensors/{sensor_id}/harvest")
async def harvest_now(sensor_id: str, email: str = Depends(unlocked_email)):
    """One-off run of the sensor's harvest flow for just this sensor (works with auto-harvest off)."""
    def _run():
        client = _client()
        row = _sensor_row(client, sensor_id)
        if not row["active"]:
            raise HTTPException(400, "Hidden sensors aren't harvested; show it on the map first")
        api = json.loads(row["source"] or "{}").get("api")
        name = {"ERDDAP": "OceanECO-sensors-ERDDAP", "ONC": "OceanECO-sensors-ONC"}.get(api)
        if not name:
            raise HTTPException(400, f"No harvest job for source {api!r}")
        d = _deployment(name)
        run = _prefect("POST", f"/deployments/{d['id']}/create_flow_run", {"parameters": {"sensor_id": sensor_id}})
        _audit(client, email, "harvest", sensor_id, row["name"], "harvest", None, run.get("id"), f"Harvest now ({name})")
        return {"runId": run.get("id")}
    return await run_in_threadpool(_run)


# ── Model status ──────────────────────────────────────────────────────────────

@router.get("/model")
async def model_status(email: str = Depends(admin_email)):
    """What this API has: data bounds from part metadata (instant), sync history from the sync logs."""
    def _run():
        client = _client()
        bounds = {}
        for table, lo, hi in (("SalishSeaCast_hourly", "min_time", "max_time"),
                              ("SalishSeaCast_daily", "min_date", "max_date")):
            r = client.query(f"SELECT min({lo}), max({hi}), sum(rows) FROM system.parts "
                             "WHERE database = currentDatabase() AND table = {t:String} AND active",
                             parameters={"t": table}).result_rows[0]
            bounds[table] = {"first": r[0].isoformat() if r[2] else None,
                             "last": r[1].isoformat() if r[2] else None, "rows": r[2]}
        logs = {}
        for table in ("SalishSeaCast_sync_log", "SalishSeaCast_daily_sync_log"):
            rows = client.query(f"SELECT date, status, updated_at FROM {table} FINAL ORDER BY date DESC LIMIT 120").result_rows
            logs[table] = [{"date": d.isoformat(), "status": s, "updated_at": u.isoformat() + "Z"} for d, s, u in rows]
        return {"bounds": bounds, "sync": logs}
    return await run_in_threadpool(_run)


# ── Storage and caches ────────────────────────────────────────────────────────

def _table_group(name: str) -> str:
    if name.startswith("SalishSeaCast_") or name == "grid_SSC":
        return "model"
    if name.startswith(("sensor", "glider_", "ship_cast")):
        return "observations"
    if name.startswith("admin_"):
        return "admin"
    return "unused"


@router.get("/storage")
async def storage(email: str = Depends(admin_email)):
    def _run():
        rows = _client().query(
            "SELECT t.name, t.engine, sum(p.bytes_on_disk), sum(p.rows) FROM system.tables AS t "
            "LEFT JOIN (SELECT table, bytes_on_disk, rows FROM system.parts WHERE active AND database = currentDatabase()) AS p "
            "ON p.table = t.name WHERE t.database = currentDatabase() GROUP BY t.name, t.engine ORDER BY 3 DESC"
        ).result_rows
        return [{"name": n, "engine": e, "bytes": int(b or 0), "rows": int(r or 0), "group": _table_group(n)}
                for n, e, b, r in rows]
    return await run_in_threadpool(_run)


@router.post("/storage/drop/{table}")
async def drop_table(table: str, req: Confirm, email: str = Depends(unlocked_email)):
    if _table_group(table) != "unused":
        raise HTTPException(400, "Only tables the app doesn't use can be dropped here")
    if req.confirm.strip() != f"drop {table}":
        raise HTTPException(400, f"Type 'drop {table}' to confirm")

    def _run():
        client = _client()
        names = {r[0] for r in client.query("SHOW TABLES").result_rows}
        if table not in names:
            raise HTTPException(404, "No such table")
        client.command(f"DROP TABLE `{table}`")  # name checked against SHOW TABLES above
        _audit(client, email, "table", table, table, "drop", "exists", "dropped", f"Dropped table {table}")
    await run_in_threadpool(_run)
    return {"ok": True}


@router.post("/cache/clear")
async def clear_cache(email: str = Depends(unlocked_email)):
    response_cache.invalidate_all()
    await run_in_threadpool(lambda: _audit(_client(), email, "cache", "response", "API response cache",
                                           "clear", None, None, "Cleared the API response cache"))
    return {"ok": True}
