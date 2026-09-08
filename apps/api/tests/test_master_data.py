from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import hash_password
from app.models import ExpenseCategory, User


def test_category_and_supplier_master_data(client: TestClient) -> None:
    category_response = client.post("/api/categories", json={"name": "房租水电", "sort_order": 10})
    assert category_response.status_code == 201
    category = category_response.json()["data"]

    child_response = client.post(
        "/api/categories",
        json={"name": "水电费", "parent_id": category["id"], "sort_order": 11},
    )
    assert child_response.status_code == 201

    duplicate_response = client.post("/api/categories", json={"name": "房租水电", "sort_order": 10})
    assert duplicate_response.status_code == 409

    supplier_response = client.post(
        "/api/suppliers",
        json={
            "name": "供电公司",
            "bank_account": "6222 **** 8899",
            "contact_name": "客服",
            "phone": "95598",
        },
    )
    assert supplier_response.status_code == 201

    supplier_page = client.get("/api/suppliers?page_size=20").json()["data"]
    assert supplier_page["total"] == 1
    assert supplier_page["items"][0]["name"] == "供电公司"


def test_update_expense_item_classification(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说分类店"}).json()["data"]["id"]
    client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"})
    expense_id = client.post(
        "/api/expense-items",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "description": "待补分类支出",
            "amount": "100.00",
        },
    ).json()["data"]["id"]

    response = client.patch(
        f"/api/expense-items/{expense_id}",
        json={
            "category_l1": "房租水电",
            "category_l2": "水电费",
            "supplier_name": "供电公司",
            "payee_account": "6222 **** 8899",
        },
    )
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["category_l1"] == "房租水电"
    assert data["supplier_name"] == "供电公司"


def test_update_category_and_supplier_status(client: TestClient) -> None:
    parent_id = client.post("/api/categories", json={"name": "运营费用"}).json()["data"]["id"]
    category_id = client.post(
        "/api/categories",
        json={"name": "维修维护", "parent_id": parent_id, "sort_order": 10},
    ).json()["data"]["id"]
    category_response = client.patch(
        f"/api/categories/{category_id}",
        json={"name": "设备维修", "sort_order": 20, "status": "inactive"},
    )
    assert category_response.status_code == 200
    category = category_response.json()["data"]
    assert category["name"] == "设备维修"
    assert category["status"] == "inactive"

    own_parent_response = client.patch(f"/api/categories/{category_id}", json={"parent_id": category_id})
    assert own_parent_response.status_code == 409

    supplier_id = client.post("/api/suppliers", json={"name": "维修公司"}).json()["data"]["id"]
    supplier_response = client.patch(
        f"/api/suppliers/{supplier_id}",
        json={"bank_account": "3003", "status": "inactive"},
    )
    assert supplier_response.status_code == 200
    supplier = supplier_response.json()["data"]
    assert supplier["bank_account"] == "3003"
    assert supplier["status"] == "inactive"

    logs = client.get("/api/audit-logs?page_size=20").json()["data"]["items"]
    assert any(log["action"] == "category.update" for log in logs)
    assert any(log["action"] == "supplier.update" for log in logs)


def test_revenue_fee_categories_are_channel_managed(client: TestClient) -> None:
    create_root_response = client.post("/api/categories", json={"name": "手续费"})
    assert create_root_response.status_code == 409

    channel_response = client.post("/api/revenue-channels", json={"name": "美团", "sort_order": 10})
    assert channel_response.status_code == 201
    category_page = client.get("/api/categories?page_size=100").json()["data"]
    fee_category = next(item for item in category_page["items"] if item["name"] == "手续费")
    fee_child = next(item for item in category_page["items"] if item["name"] == "美团手续费")

    create_child_response = client.post(
        "/api/categories",
        json={"name": "手工手续费", "parent_id": fee_category["id"]},
    )
    assert create_child_response.status_code == 409

    edit_root_response = client.patch(f"/api/categories/{fee_category['id']}", json={"name": "渠道手续费"})
    assert edit_root_response.status_code == 409

    disable_child_response = client.patch(f"/api/categories/{fee_child['id']}", json={"status": "inactive"})
    assert disable_child_response.status_code == 409


def test_food_cost_root_category_is_metric_managed(client: TestClient, session: Session) -> None:
    food_cost = ExpenseCategory(name="食材成本", parent_id=None, sort_order=5)
    session.add(food_cost)
    session.commit()

    create_child_response = client.post(
        "/api/categories",
        json={"name": "肉类", "parent_id": food_cost.id, "sort_order": 6},
    )
    assert create_child_response.status_code == 201

    edit_root_response = client.patch(f"/api/categories/{food_cost.id}", json={"name": "原材料成本"})
    assert edit_root_response.status_code == 409

    disable_root_response = client.patch(f"/api/categories/{food_cost.id}", json={"status": "inactive"})
    assert disable_root_response.status_code == 409


def test_admin_can_manage_virtual_store_groups_and_assign_stores(client: TestClient) -> None:
    group_response = client.post(
        "/api/stores/groups",
        json={"name": "华东区域", "sort_order": 10},
    )
    assert group_response.status_code == 201
    group = group_response.json()["data"]

    store_response = client.post(
        "/api/stores",
        json={"name": "蘑说分组门店", "group_id": group["id"]},
    )
    assert store_response.status_code == 201
    store = store_response.json()["data"]
    assert store["group_id"] == group["id"]

    groups_response = client.get("/api/stores/groups")
    assert groups_response.status_code == 200
    assert groups_response.json()["data"] == [
        {
            **group,
            "store_count": 1,
        }
    ]

    delete_response = client.delete(f"/api/stores/groups/{group['id']}")
    assert delete_response.status_code == 200
    assert delete_response.json()["data"] == {"ok": True}

    stores_response = client.get("/api/stores?page_size=20")
    assert stores_response.status_code == 200
    assert stores_response.json()["data"]["items"][0]["id"] == store["id"]
    assert stores_response.json()["data"]["items"][0]["group_id"] is None


def test_non_admin_cannot_manage_or_assign_virtual_store_groups(
    client: TestClient,
    session: Session,
) -> None:
    group_id = client.post("/api/stores/groups", json={"name": "直营门店"}).json()["data"]["id"]
    store_id = client.post("/api/stores", json={"name": "蘑说权限分组门店"}).json()["data"]["id"]
    session.add(
        User(
            username="store_operator",
            display_name="门店运营",
            password_hash=hash_password("secret123"),
            role="finance",
            status="active",
        )
    )
    session.commit()

    login_response = client.post(
        "/api/auth/login",
        json={"username": "store_operator", "password": "secret123"},
    )
    assert login_response.status_code == 200

    assert client.get("/api/stores/groups").status_code == 200
    assert client.post("/api/stores/groups", json={"name": "无权限分组"}).status_code == 403
    assert (
        client.patch(
            f"/api/stores/{store_id}",
            json={"group_id": group_id},
        ).status_code
        == 403
    )
    assert (
        client.patch(
            f"/api/stores/{store_id}",
            json={"group_id": None},
        ).status_code
        == 403
    )
