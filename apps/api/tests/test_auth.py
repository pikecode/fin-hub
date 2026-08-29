from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import hash_password
from app.models import User


def test_login_me_and_logout(anonymous_client: TestClient, session: Session) -> None:
    session.add(
        User(
            username="admin",
            display_name="系统管理员",
            password_hash=hash_password("admin123456"),
            role="admin",
            status="active",
        )
    )
    session.commit()

    login_response = anonymous_client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "admin123456"},
    )
    assert login_response.status_code == 200
    assert login_response.json()["data"]["username"] == "admin"
    assert "fin_hub_session" in login_response.cookies

    me_response = anonymous_client.get("/api/auth/me")
    assert me_response.status_code == 200
    assert me_response.json()["data"]["role"] == "admin"

    logout_response = anonymous_client.post("/api/auth/logout")
    assert logout_response.status_code == 200


def test_login_rejects_bad_password(anonymous_client: TestClient, session: Session) -> None:
    session.add(
        User(
            username="admin",
            display_name="系统管理员",
            password_hash=hash_password("admin123456"),
            role="admin",
            status="active",
        )
    )
    session.commit()

    response = anonymous_client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "wrong"},
    )
    assert response.status_code == 401


def test_write_api_requires_authentication(anonymous_client: TestClient) -> None:
    response = anonymous_client.post("/api/stores", json={"name": "未登录门店"})
    assert response.status_code == 401
