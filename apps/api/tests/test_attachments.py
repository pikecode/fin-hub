from pathlib import Path

from fastapi.testclient import TestClient

from app.core.config import settings
from app.models import Attachment, AttachmentStatus, Ledger, LedgerStatus


def create_expense(client: TestClient) -> tuple[str, str]:
    store_id = client.post("/api/stores", json={"name": "蘑说附件店"}).json()["data"]["id"]
    ledger_id = client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"}).json()["data"]["id"]
    item_id = client.post(
        "/api/expense-items",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "description": "附件测试支出",
            "amount": "88.00",
        },
    ).json()["data"]["id"]
    return ledger_id, item_id


def test_upload_list_and_download_attachment(client: TestClient, tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(settings, "file_storage_root", str(tmp_path))
    _, item_id = create_expense(client)

    upload_response = client.post(
        f"/api/attachments?resource_type=expense_item&resource_id={item_id}",
        files={"file": ("voucher.txt", b"voucher-content", "text/plain")},
    )
    assert upload_response.status_code == 201
    attachment = upload_response.json()["data"]
    assert attachment["file_name"] == "voucher.txt"
    assert attachment["file_size"] == len(b"voucher-content")
    assert attachment["download_status"] == "stored"

    list_response = client.get(f"/api/attachments?resource_type=expense_item&resource_id={item_id}")
    assert list_response.status_code == 200
    assert list_response.json()["data"]["total"] == 1

    download_response = client.get(f"/api/attachments/{attachment['id']}/download")
    assert download_response.status_code == 200
    assert download_response.content == b"voucher-content"

    logs = client.get("/api/audit-logs?action=attachment.upload&page_size=20").json()["data"]["items"]
    assert any(log["resource_id"] == attachment["id"] for log in logs)


def test_upload_attachment_rejects_closed_ledger(client: TestClient, tmp_path: Path, monkeypatch, session) -> None:
    monkeypatch.setattr(settings, "file_storage_root", str(tmp_path))
    ledger_id, item_id = create_expense(client)
    ledger = session.get(Ledger, ledger_id)
    ledger.status = LedgerStatus.CLOSED.value
    session.commit()

    response = client.post(
        f"/api/attachments?resource_type=expense_item&resource_id={item_id}",
        files={"file": ("voucher.txt", b"voucher-content", "text/plain")},
    )
    assert response.status_code == 409


def test_download_dingtalk_url_placeholder(client: TestClient, tmp_path: Path, monkeypatch, session) -> None:
    monkeypatch.setattr(settings, "file_storage_root", str(tmp_path))
    _, item_id = create_expense(client)
    attachment = Attachment(
        resource_type="expense_item",
        resource_id=item_id,
        file_name="dingtalk-voucher.txt",
        source="dingtalk",
        external_file_id="https://static.dingtalk.com/voucher.txt",
        download_status=AttachmentStatus.PLACEHOLDER.value,
    )
    session.add(attachment)
    session.commit()
    session.refresh(attachment)

    class FakeResponse:
        def __init__(self) -> None:
            self.content = b"dingtalk-voucher-content"
            self.headers = {"content-type": "text/plain"}

        def raise_for_status(self) -> None:
            return None

    def fake_get(url, timeout):
        assert url == "https://static.dingtalk.com/voucher.txt"
        assert timeout == 30.0
        return FakeResponse()

    monkeypatch.setattr("app.modules.attachments.router.httpx.get", fake_get)
    response = client.post(f"/api/attachments/{attachment.id}/download-dingtalk")
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["download_status"] == "stored"
    assert data["file_size"] == len(b"dingtalk-voucher-content")

    download_response = client.get(f"/api/attachments/{attachment.id}/download")
    assert download_response.status_code == 200
    assert download_response.content == b"dingtalk-voucher-content"

    logs = client.get("/api/audit-logs?action=attachment.dingtalk_download&page_size=20").json()["data"]["items"]
    assert any(log["resource_id"] == attachment.id for log in logs)
