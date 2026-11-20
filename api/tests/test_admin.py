"""Admin dashboard: input validation and the auth/lock guards (no ClickHouse needed)."""
import pytest
from fastapi import HTTPException
from starlette.requests import Request

from modules import admin


def _req(origin=None):
    headers = [(b"origin", origin.encode())] if origin else []
    return Request({"type": "http", "headers": headers})


def test_sensor_fields():
    assert admin._validate_sensor_field("active", False) == 0
    assert admin._validate_sensor_field("depth", "12.5") == 12.5
    for field, value in (("name", " "), ("active", "yes"), ("id", "x"), ("variables", {"t": {"conversion_factor": "x"}})):
        with pytest.raises(HTTPException):
            admin._validate_sensor_field(field, value)


def test_only_unused_tables_droppable():
    assert admin._table_group("LiveOcean_4h") == "unused"
    for t in ("sensors", "sensor_timeseries", "SalishSeaCast_daily", "admin_audit", "glider_profiles"):
        assert admin._table_group(t) != "unused"


def test_foreign_origin_and_unconfigured_auth(monkeypatch):
    monkeypatch.setattr(admin, "ADMIN_ORIGINS", {"https://app.example"})
    monkeypatch.setattr(admin, "CF_ACCESS_AUD", "")
    monkeypatch.setattr(admin, "ADMIN_DEV_EMAIL", "")
    with pytest.raises(HTTPException) as e:
        admin.admin_email(_req("https://evil.example"), None)
    assert e.value.status_code == 403
    with pytest.raises(HTTPException) as e:
        admin.admin_email(_req("https://app.example"), None)
    assert e.value.status_code == 503


def test_access_token_required_when_configured(monkeypatch):
    monkeypatch.setattr(admin, "CF_ACCESS_AUD", "aud")
    monkeypatch.setattr(admin, "CF_ACCESS_TEAM_DOMAIN", "team.cloudflareaccess.com")
    monkeypatch.setattr(admin, "ADMIN_DEV_EMAIL", "dev@localhost")  # ignored once Access is configured
    with pytest.raises(HTTPException) as e:
        admin.admin_email(_req(), None)
    assert e.value.status_code == 401
    with pytest.raises(HTTPException) as e:
        admin.admin_email(_req(), "not-a-jwt")
    assert e.value.status_code == 401


def test_locked_writes_refused():
    admin._unlocked_until.pop("a@b", None)
    with pytest.raises(HTTPException) as e:
        admin.unlocked_email("a@b")
    assert e.value.status_code == 423
    admin.unlock("a@b")
    assert admin.unlocked_email("a@b") == "a@b"
    admin.lock("a@b")
