from fastapi.testclient import TestClient


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
