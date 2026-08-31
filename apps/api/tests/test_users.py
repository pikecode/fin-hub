from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import hash_password
from app.models import User


def test_admin_can_create_update_and_list_users(client: TestClient) -> None:
    create_response = client.post(
        "/api/users",
        json={
            "username": "finance_user",
            "display_name": "财务用户",
            "password": "secret123",
            "role": "finance",
        },
    )
    assert create_response.status_code == 201
    user = create_response.json()["data"]
    assert user["username"] == "finance_user"
    assert user["status"] == "active"

    update_response = client.patch(
        f"/api/users/{user['id']}",
        json={"display_name": "财务负责人", "status": "disabled"},
    )
    assert update_response.status_code == 200
    updated = update_response.json()["data"]
    assert updated["display_name"] == "财务负责人"
    assert updated["status"] == "disabled"

    list_response = client.get("/api/users?page_size=20")
    assert list_response.status_code == 200
    assert list_response.json()["data"]["total"] == 2

    logs = client.get("/api/audit-logs?resource_type=user&page_size=20").json()["data"]["items"]
    assert any(log["action"] == "user.create" for log in logs)
    assert any(log["action"] == "user.update" for log in logs)


def test_finance_user_cannot_manage_users(anonymous_client: TestClient, session: Session) -> None:
    session.add(
        User(
            username="finance",
            display_name="财务",
            password_hash=hash_password("secret123"),
            role="finance",
            status="active",
        )
    )
    session.commit()
    login_response = anonymous_client.post(
        "/api/auth/login",
        json={"username": "finance", "password": "secret123"},
    )
    assert login_response.status_code == 200

    response = anonymous_client.get("/api/users")
    assert response.status_code == 403


def test_user_permissions_and_store_scope_are_persisted(client: TestClient) -> None:
    first_store_id = client.post("/api/stores", json={"name": "蘑说权限店 A"}).json()["data"]["id"]
    client.post("/api/stores", json={"name": "蘑说权限店 B"})

    create_response = client.post(
        "/api/users",
        json={
            "username": "limited_finance",
            "display_name": "受限财务",
            "password": "secret123",
            "role": "finance",
            "permissions": ["stores.view", "reconciliation.view"],
            "store_ids": [first_store_id],
        },
    )
    assert create_response.status_code == 201
    created_user = create_response.json()["data"]
    assert created_user["permissions"] == ["categories.view", "dingtalk.view", "reconciliation.view", "stores.view"]
    assert created_user["store_ids"] == [first_store_id]

    login_response = client.post(
        "/api/auth/login",
        json={"username": "limited_finance", "password": "secret123"},
    )
    assert login_response.status_code == 200
    current_user = client.get("/api/auth/me").json()["data"]
    assert current_user["permissions"] == ["categories.view", "dingtalk.view", "reconciliation.view", "stores.view"]
    assert current_user["store_ids"] == [first_store_id]

    stores_response = client.get("/api/stores?page_size=20")
    assert stores_response.status_code == 200
    stores = stores_response.json()["data"]["items"]
    assert [store["id"] for store in stores] == [first_store_id]


def test_explicit_empty_permissions_do_not_fall_back_to_role_defaults(client: TestClient) -> None:
    create_response = client.post(
        "/api/users",
        json={
            "username": "no_permission_finance",
            "display_name": "无权限财务",
            "password": "secret123",
            "role": "finance",
            "permissions": [],
            "store_ids": [],
        },
    )
    assert create_response.status_code == 201

    client.post(
        "/api/auth/login",
        json={"username": "no_permission_finance", "password": "secret123"},
    )
    current_user = client.get("/api/auth/me").json()["data"]
    assert current_user["permissions"] == []
    assert client.get("/api/stores").status_code == 403
