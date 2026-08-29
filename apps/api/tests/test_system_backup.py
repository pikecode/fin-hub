from fastapi.testclient import TestClient

from app.core.config import settings


def test_database_backup_status_requires_admin(client: TestClient) -> None:
    response = client.get("/api/system/database-backup/status")
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["backend"] == "sqlite"
    assert data["supported"] is False
    assert "原生备份工具" in data["message"] or "SQLite 数据库文件不存在" in data["message"]


def test_database_backup_download_rejects_unsupported_database(client: TestClient) -> None:
    response = client.get("/api/system/database-backup/download")
    assert response.status_code == 409


def test_system_readiness_reports_blocking_production_issues(client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(settings, "app_env", "production")
    monkeypatch.setattr(settings, "secret_key", "dev-secret")
    monkeypatch.setattr(settings, "cors_origin_csv", "http://localhost:3000")

    response = client.get("/api/system/readiness")
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["environment"] == "production"
    assert data["ready"] is False
    checks = {item["key"]: item for item in data["checks"]}
    assert checks["database"]["status"] == "error"
    assert checks["secret-key"]["status"] == "error"
    assert checks["cors"]["status"] == "error"


def test_system_readiness_allows_local_with_warnings(client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(settings, "app_env", "local")
    monkeypatch.setattr(settings, "secret_key", "x" * 32)
    monkeypatch.setattr(settings, "cors_origin_csv", "http://localhost:3000")
    monkeypatch.setattr(settings, "dingtalk_sync_mode", "mock")
    login_response = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "admin123456"},
    )
    assert login_response.status_code == 200

    response = client.get("/api/system/readiness")
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["environment"] == "local"
    assert data["ready"] is True
    checks = {item["key"]: item for item in data["checks"]}
    assert checks["database"]["status"] == "ok"
    assert checks["secret-key"]["status"] == "ok"
    assert checks["dingtalk"]["status"] == "warning"
