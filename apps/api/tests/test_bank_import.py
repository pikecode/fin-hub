from fastapi.testclient import TestClient
from openpyxl import Workbook


def test_batch_delete_bank_transactions(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "批量删除流水店"}).json()["data"]["id"]
    payload = {
        "store_id": store_id,
        "ledger_period": "2026-08",
        "occurred_at": "2026-08-20T10:00:00",
        "direction": "expense",
        "amount": "100.00",
        "counterparty_name": "测试收款方",
    }
    first_id = client.post("/api/bank-transactions", json=payload).json()["data"]["id"]
    second_id = client.post(
        "/api/bank-transactions",
        json={**payload, "occurred_at": "2026-08-21T10:00:00", "amount": "200.00"},
    ).json()["data"]["id"]

    response = client.request(
        "DELETE",
        "/api/bank-transactions/batch",
        json={"ids": [first_id, second_id]},
    )

    assert response.status_code == 200
    assert response.json()["data"]["deleted_count"] == 2
    list_response = client.get(f"/api/bank-transactions?store_id={store_id}")
    assert list_response.json()["data"]["total"] == 0


def test_list_bank_transactions_filters_by_match_status_and_counterparty(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "流水筛选店"}).json()["data"]["id"]
    client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"})
    expense_id = client.post(
        "/api/expense-items",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "description": "供应商货款",
            "amount": "100.00",
        },
    ).json()["data"]["id"]
    matched_id = client.post(
        "/api/bank-transactions",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "occurred_at": "2026-08-20T10:00:00",
            "direction": "expense",
            "amount": "100.00",
            "counterparty_name": "测试供应商",
            "counterparty_account": "62220001",
        },
    ).json()["data"]["id"]
    client.post(
        "/api/bank-transactions",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "occurred_at": "2026-08-21T10:00:00",
            "direction": "expense",
            "amount": "200.00",
            "counterparty_name": "另一收款方",
            "counterparty_account": "62220002",
        },
    )
    match_id = client.post(
        "/api/matches",
        json={"expense_item_id": expense_id, "bank_transaction_id": matched_id, "amount": "100.00"},
    ).json()["data"]["id"]
    client.post(f"/api/matches/{match_id}/confirm?operator=tester")

    matched_response = client.get(f"/api/bank-transactions?store_id={store_id}&match_status=matched&counterparty_name=供应商")
    assert matched_response.status_code == 200
    assert matched_response.json()["data"]["total"] == 1
    assert matched_response.json()["data"]["items"][0]["id"] == matched_id

    unmatched_response = client.get(f"/api/bank-transactions?store_id={store_id}&match_status=unmatched&counterparty_account=0002")
    assert unmatched_response.status_code == 200
    assert unmatched_response.json()["data"]["total"] == 1


def test_download_bank_import_template(client: TestClient) -> None:
    response = client.get("/api/bank-transactions/import/template.csv")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert "bank-import-template.csv" in response.headers["content-disposition"]
    assert response.content.startswith("\ufeff".encode("utf-8"))
    text = response.content.decode("utf-8-sig")
    assert "发生时间,类型,金额,对方户名,对方账号,备注,流水号" in text
    assert "2026-08-20 10:00:00,收入,1200.00" in text


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
    job_id = data["job"]["id"]

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
    assert {item["import_job_id"] for item in list_response.json()["data"]["items"]} == {job_id}

    jobs_response = client.get("/api/dingtalk/sync-jobs")
    assert jobs_response.status_code == 200
    assert jobs_response.json()["data"]["total"] == 2

    filtered_jobs_response = client.get("/api/dingtalk/sync-jobs?job_type=bank_transaction_import")
    assert filtered_jobs_response.status_code == 200
    assert filtered_jobs_response.json()["data"]["total"] == 2
    assert {
        item["job_type"] for item in filtered_jobs_response.json()["data"]["items"]
    } == {"bank_transaction_import"}


def test_rollback_bank_import_deletes_unmatched_imported_transactions(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说流水回滚店"}).json()["data"]["id"]
    client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"})
    csv_content = "\n".join(
        [
            "发生时间,方向,金额,对方户名,流水号",
            "2026-08-20 10:00:00,支出,120.00,维修供应商,BANK-ROLLBACK-001",
            "2026-08-21 11:30:00,收入,300.00,营业款,BANK-ROLLBACK-002",
        ]
    )
    import_response = client.post(
        "/api/bank-transactions/import",
        data={"store_id": store_id, "ledger_period": "2026-08", "started_by": "tester"},
        files={"file": ("bank.csv", csv_content.encode("utf-8"), "text/csv")},
    )
    job_id = import_response.json()["data"]["job"]["id"]

    rollback_response = client.post(f"/api/bank-transactions/imports/{job_id}/rollback?operator=tester")

    assert rollback_response.status_code == 200
    rollback = rollback_response.json()["data"]
    assert rollback["deleted_count"] == 2
    assert rollback["job"]["status"] == "failed"
    assert rollback["job"]["error_message"] == "Rolled back by operator"
    assert client.get("/api/bank-transactions?store_id=" + store_id).json()["data"]["total"] == 0
    logs = client.get("/api/audit-logs?resource_type=sync_job&page_size=20").json()["data"]["items"]
    assert any(log["action"] == "bank_transaction_import.rollback" and log["resource_id"] == job_id for log in logs)


def test_rollback_bank_import_rejects_matched_transactions(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说已匹配回滚店"}).json()["data"]["id"]
    client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"})
    expense_id = client.post(
        "/api/expense-items",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "description": "导入后匹配支出",
            "amount": "120.00",
        },
    ).json()["data"]["id"]
    csv_content = "\n".join(
        [
            "发生时间,方向,金额,对方户名,流水号",
            "2026-08-20 10:00:00,支出,120.00,维修供应商,BANK-ROLLBACK-MATCHED",
        ]
    )
    import_response = client.post(
        "/api/bank-transactions/import",
        data={"store_id": store_id, "ledger_period": "2026-08", "started_by": "tester"},
        files={"file": ("bank.csv", csv_content.encode("utf-8"), "text/csv")},
    )
    job_id = import_response.json()["data"]["job"]["id"]
    bank_id = client.get("/api/bank-transactions?store_id=" + store_id).json()["data"]["items"][0]["id"]
    match_id = client.post(
        "/api/matches",
        json={"expense_item_id": expense_id, "bank_transaction_id": bank_id, "amount": "120.00"},
    ).json()["data"]["id"]
    client.post(f"/api/matches/{match_id}/confirm?operator=tester")

    rollback_response = client.post(f"/api/bank-transactions/imports/{job_id}/rollback?operator=tester")

    assert rollback_response.status_code == 409
    assert rollback_response.json()["detail"] == "Imported transactions already matched"
    assert client.get("/api/bank-transactions?store_id=" + store_id).json()["data"]["total"] == 1


def test_rollback_bank_import_rejects_candidate_match_records(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说候选匹配回滚店"}).json()["data"]["id"]
    client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"})
    expense_id = client.post(
        "/api/expense-items",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "description": "导入后候选支出",
            "amount": "120.00",
        },
    ).json()["data"]["id"]
    csv_content = "\n".join(
        [
            "发生时间,方向,金额,对方户名,流水号",
            "2026-08-20 10:00:00,支出,120.00,维修供应商,BANK-ROLLBACK-CANDIDATE",
        ]
    )
    import_response = client.post(
        "/api/bank-transactions/import",
        data={"store_id": store_id, "ledger_period": "2026-08", "started_by": "tester"},
        files={"file": ("bank.csv", csv_content.encode("utf-8"), "text/csv")},
    )
    job_id = import_response.json()["data"]["job"]["id"]
    bank_id = client.get("/api/bank-transactions?store_id=" + store_id).json()["data"]["items"][0]["id"]
    client.post(
        "/api/matches",
        json={"expense_item_id": expense_id, "bank_transaction_id": bank_id, "amount": "120.00"},
    )

    rollback_response = client.post(f"/api/bank-transactions/imports/{job_id}/rollback?operator=tester")

    assert rollback_response.status_code == 409
    assert rollback_response.json()["detail"] == "Imported transactions already have match records"
    assert client.get("/api/bank-transactions?store_id=" + store_id).json()["data"]["total"] == 1


def test_import_bank_transactions_requires_store_assignment(client: TestClient) -> None:
    csv_content = "\n".join(
        [
            "日期,收入还是支出,金额,备注",
            "2026-08-20,支出,300.00,门店报销付款",
        ]
    )

    response = client.post(
        "/api/bank-transactions/import-csv",
        data={"started_by": "tester"},
        files={"file": ("bank.csv", csv_content.encode("utf-8"), "text/csv")},
    )
    assert response.status_code == 422

    preview_response = client.post(
        "/api/bank-transactions/import/preview",
        files={"file": ("bank.csv", csv_content.encode("utf-8"), "text/csv")},
    )
    assert preview_response.status_code == 422


def test_import_bank_transactions_for_store_derives_period_per_row(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说跨月流水店"}).json()["data"]["id"]
    csv_content = "\n".join(
        [
            "日期,收入还是支出,金额,备注",
            "2026/8/31,支出,12005,备注4",
            "2026/9/1,支出,12006,备注5",
        ]
    )

    response = client.post(
        "/api/bank-transactions/import",
        data={"store_id": store_id, "started_by": "tester"},
        files={"file": ("bank.csv", csv_content.encode("utf-8"), "text/csv")},
    )

    assert response.status_code == 201
    assert response.json()["data"]["created_count"] == 2
    transactions = client.get(f"/api/bank-transactions?store_id={store_id}&page_size=10").json()["data"]["items"]
    assert {transaction["ledger_period"] for transaction in transactions} == {"2026-08", "2026-09"}


def test_import_bank_transactions_creates_missing_fixed_ledger(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说固定账期导入店"}).json()["data"]["id"]
    csv_content = "\n".join(
        [
            "日期,收入还是支出,金额,备注",
            "2026-08-20,支出,300.00,门店报销付款",
        ]
    )

    response = client.post(
        "/api/bank-transactions/import",
        data={"store_id": store_id, "ledger_period": "2026-08", "started_by": "tester"},
        files={"file": ("bank.csv", csv_content.encode("utf-8"), "text/csv")},
    )

    assert response.status_code == 201
    assert response.json()["data"]["created_count"] == 1
    transactions = client.get(f"/api/bank-transactions?store_id={store_id}&ledger_period=2026-08").json()["data"]["items"]
    assert transactions[0]["summary"] == "门店报销付款"
    ledger_response = client.get(f"/api/ledgers?store_id={store_id}&period=2026-08")
    assert ledger_response.json()["data"]["total"] == 1


def test_preview_bank_transactions_creates_missing_fixed_ledger_for_validation(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说固定账期预览店"}).json()["data"]["id"]
    csv_content = "\n".join(
        [
            "日期,收入还是支出,金额,备注",
            "2026-08-20,支出,300.00,门店报销付款",
        ]
    )

    response = client.post(
        "/api/bank-transactions/import/preview",
        data={"store_id": store_id, "ledger_period": "2026-08"},
        files={"file": ("bank.csv", csv_content.encode("utf-8"), "text/csv")},
    )

    assert response.status_code == 200
    assert response.json()["data"]["valid_count"] == 1


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
