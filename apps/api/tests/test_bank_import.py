from fastapi.testclient import TestClient
from openpyxl import Workbook


def test_import_bank_transactions_csv_and_skip_duplicates(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说流水导入店"}).json()["data"]["id"]
    client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"})

    csv_content = "\n".join(
        [
            "发生时间,方向,金额,对方户名,对方账号,摘要,流水号",
            "2026-08-20 10:00:00,收入,1200.00,门店营业款,1001,营业款,BANK-IMPORT-001",
            "2026-08-21 11:30:00,支出,300.00,物料供应商,2002,物料款,BANK-IMPORT-002",
        ]
    )

    response = client.post(
        "/api/bank-transactions/import-csv",
        data={"store_id": store_id, "ledger_period": "2026-08", "started_by": "tester"},
        files={"file": ("bank.csv", csv_content.encode("utf-8"), "text/csv")},
    )
    assert response.status_code == 201
    data = response.json()["data"]
    assert data["created_count"] == 2
    assert data["skipped_count"] == 0
    assert data["job"]["status"] == "succeeded"

    duplicate_response = client.post(
        "/api/bank-transactions/import-csv",
        data={"store_id": store_id, "ledger_period": "2026-08", "started_by": "tester"},
        files={"file": ("bank.csv", csv_content.encode("utf-8"), "text/csv")},
    )
    assert duplicate_response.status_code == 201
    assert duplicate_response.json()["data"]["created_count"] == 0
    assert duplicate_response.json()["data"]["skipped_count"] == 2

    list_response = client.get("/api/bank-transactions?store_id=" + store_id)
    assert list_response.status_code == 200
    assert list_response.json()["data"]["total"] == 2

    jobs_response = client.get("/api/dingtalk/sync-jobs")
    assert jobs_response.status_code == 200
    assert jobs_response.json()["data"]["total"] == 2


def test_preview_bank_transactions_import(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说流水预览店"}).json()["data"]["id"]
    client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"})
    client.post(
        "/api/bank-transactions",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "occurred_at": "2026-08-20T10:00:00",
            "direction": "expense",
            "amount": "120.00",
            "counterparty_name": "已存在供应商",
            "bank_serial_no": "BANK-PREVIEW-EXISTS",
        },
    )

    csv_content = "\n".join(
        [
            "发生时间,方向,金额,对方户名,流水号",
            "2026-08-20 10:00:00,支出,120.00,已存在供应商,BANK-PREVIEW-EXISTS",
            "2026-08-21 11:30:00,收入,300.00,营业款,BANK-PREVIEW-NEW",
            "2026-08-22 11:30:00,错误方向,88.00,异常供应商,BANK-PREVIEW-ERR",
        ]
    )

    response = client.post(
        "/api/bank-transactions/import/preview",
        data={"store_id": store_id, "ledger_period": "2026-08"},
        files={"file": ("bank.csv", csv_content.encode("utf-8"), "text/csv")},
    )
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["valid_count"] == 1
    assert data["duplicate_count"] == 1
    assert data["error_count"] == 1
    assert data["preview_rows"][0]["duplicate"] is True
    assert data["preview_rows"][1]["bank_serial_no"] == "BANK-PREVIEW-NEW"
    assert data["row_errors"][0]["row_number"] == 4

    list_response = client.get("/api/bank-transactions?store_id=" + store_id)
    assert list_response.json()["data"]["total"] == 1


def test_import_bank_transactions_xlsx(client: TestClient, tmp_path) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说 Excel 导入店"}).json()["data"]["id"]
    client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"})

    workbook = Workbook()
    sheet = workbook.active
    sheet.append(["发生时间", "方向", "金额", "对方户名", "对方账号", "摘要", "流水号"])
    sheet.append(["2026-08-22 09:15:00", "支出", "188.50", "维修供应商", "3003", "维修费", "BANK-XLSX-001"])
    file_path = tmp_path / "bank.xlsx"
    workbook.save(file_path)

    response = client.post(
        "/api/bank-transactions/import-csv",
        data={"store_id": store_id, "ledger_period": "2026-08", "started_by": "tester"},
        files={
            "file": (
                "bank.xlsx",
                file_path.read_bytes(),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        },
    )
    assert response.status_code == 201
    data = response.json()["data"]
    assert data["created_count"] == 1
    assert data["skipped_count"] == 0

    transactions = client.get("/api/bank-transactions?store_id=" + store_id).json()["data"]["items"]
    assert transactions[0]["bank_serial_no"] == "BANK-XLSX-001"


def test_import_bank_transactions_returns_row_errors(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说错误导入店"}).json()["data"]["id"]
    client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"})

    csv_content = "\n".join(
        [
            "发生时间,方向,金额,对方户名,流水号",
            "2026-08-20 10:00:00,支出,120.00,维修供应商,BANK-IMPORT-ERR-001",
            "2026-08-21 11:30:00,错误方向,300.00,物料供应商,BANK-IMPORT-ERR-002",
        ]
    )

    response = client.post(
        "/api/bank-transactions/import",
        data={"store_id": store_id, "ledger_period": "2026-08", "started_by": "tester"},
        files={"file": ("bank.csv", csv_content.encode("utf-8"), "text/csv")},
    )
    assert response.status_code == 201
    data = response.json()["data"]
    assert data["created_count"] == 1
    assert data["row_errors"][0]["row_number"] == 3
    assert "Unsupported direction" in data["row_errors"][0]["message"]
    assert data["job"]["status"] == "failed"
