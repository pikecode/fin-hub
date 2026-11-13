import json
from datetime import timedelta

from test_miniapp import setup

from app.models import FinancialReportExport, UserStorePermission, utc_now
from app.modules.miniapp.router import make_token


def test_export_snapshot_files_and_dynamic_scope(client, session, tmp_path, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "file_storage_root", str(tmp_path))
    a, b, user = setup(session)
    a.name = "授权门店<script>alert(1)</script>"
    session.commit()
    client.cookies.clear()
    headers = {"authorization": "Bearer " + make_token(user)}
    url = "/api/miniapp/report-exports"
    denied = client.post(url, json={"store_id": b.id, "period": "2026-10"}, headers=headers)
    assert denied.status_code == 403
    created = client.post(url, json={"store_id": a.id, "period": "2026-10"}, headers=headers)
    assert created.status_code == 200, created.text
    job_id = created.json()["data"]["id"]
    status = client.get(url + "/" + job_id, headers=headers)
    assert status.json()["data"]["status"] == "ready", status.text
    for kind in ["html", "pdf"]:
        response = client.get(
            url + "/" + job_id + "/download", params={"format": kind}, headers=headers
        )
        assert response.status_code == 200, response.text
        if kind == "pdf":
            assert response.content.startswith(b"%PDF")
        else:
            assert "利润分红" in response.text
            assert "<script>" not in response.text
            assert "&lt;script&gt;" in response.text
    session.expire_all()
    job = session.get(FinancialReportExport, job_id)
    snapshot = json.loads(job.snapshot_json)
    assert snapshot["report"]["period"] == "2026-10"
    assert snapshot["report"]["metrics"]["expense_amount"] == "0.00"
    # Persist representative output only in the pytest artifact directory.
    assert (tmp_path / "report_exports" / job_id / "report.pdf").is_file()
    grant = session.query(UserStorePermission).filter_by(user_id=user.id, store_id=a.id).one()
    session.delete(grant)
    session.commit()
    assert client.get(url + "/" + job_id + "/download", headers=headers).status_code == 403
    assert client.get(url + "/" + job_id, headers=headers).status_code == 403


def test_export_expiration_and_missing_jobs(client, session, tmp_path, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "file_storage_root", str(tmp_path))
    a, _b, user = setup(session)
    client.cookies.clear()
    headers = {"authorization": "Bearer " + make_token(user)}
    row = FinancialReportExport(
        user_id=user.id,
        store_id=a.id,
        period="2026-10",
        status="ready",
        expires_at=utc_now() - timedelta(seconds=1),
    )
    session.add(row)
    session.commit()
    assert client.get("/api/miniapp/report-exports/" + row.id, headers=headers).status_code == 410
    assert client.get("/api/miniapp/report-exports/missing", headers=headers).status_code == 404


def test_rich_pdf_cjk_receipts_and_no_duplicate_payment_cost(
    client, session, tmp_path, monkeypatch
):
    from datetime import date
    from decimal import Decimal
    from io import BytesIO

    from PIL import Image
    from pypdf import PdfReader
    from test_accruals import matched_approval

    from app.core.config import settings
    from app.models import Attachment, ExpenseItem

    monkeypatch.setattr(settings, "file_storage_root", str(tmp_path))
    a, _b, user = setup(session)
    _approval, item, _bank, _match = matched_approval(
        session, a.id, "63940", period="2026-10", suffix="export-rich"
    )
    # The renderer includes a long detail table and a genuine stored image.
    for i in range(65):
        session.add(
            ExpenseItem(
                store_id=a.id,
                ledger_period="2026-10",
                expense_date=date(2026, 10, 2),
                source="kuailv_purchase",
                description="厨房采购中文长内容测试 " + str(i),
                amount="12.34",
                category_l1="食材成本",
                category_l2="采购",
            )
        )
    buf = BytesIO()
    Image.new("RGB", (640, 400), "#cde8d8").save(buf, format="PNG")
    (tmp_path / "attachments").mkdir(exist_ok=True)
    file = tmp_path / "attachments" / "receipt.png"
    file.write_bytes(buf.getvalue())
    session.add(
        Attachment(
            resource_type="expense_item",
            resource_id=item.id,
            file_name="工资凭证.png",
            content_type="image/png",
            source="manual",
            download_status="stored",
            file_path="receipt.png",
        )
    )
    session.commit()
    client.cookies.clear()
    headers = {"authorization": "Bearer " + make_token(user)}
    created = client.post(
        "/api/miniapp/report-exports", json={"store_id": a.id, "period": "2026-10"}, headers=headers
    )
    assert created.status_code == 200, created.text
    job_id = created.json()["data"]["id"]
    status = client.get("/api/miniapp/report-exports/" + job_id, headers=headers)
    assert status.json()["data"]["status"] == "ready", status.text
    pdf = client.get(
        "/api/miniapp/report-exports/" + job_id + "/download?format=pdf", headers=headers
    ).content
    reader = PdfReader(BytesIO(pdf))
    text = "\n".join(page.extract_text() for page in reader.pages)
    assert len(reader.pages) >= 3
    assert "利润分红" in text and "厨房采购中文长内容测试" in text
    assert "63,940.00" in text
    html = client.get(
        "/api/miniapp/report-exports/" + job_id + "/download?format=html", headers=headers
    ).text
    assert "data:image/jpeg;base64," in html
    assert "厨房采购中文长内容测试 64" in html
    # Keep artifacts in pytest's temporary directory for PDF visual inspection.
    (tmp_path / "representative.pdf").write_bytes(pdf)
    (tmp_path / "representative.html").write_text(html)
    session.expire_all()
    snapshot = json.loads(session.get(FinancialReportExport, job_id).snapshot_json)
    assert Decimal(snapshot["report"]["metrics"]["expense_amount"]) == Decimal(
        63940
    ) + 65 * Decimal("12.34")
    (tmp_path / "snapshot.json").write_text(json.dumps(snapshot, ensure_ascii=False))


def test_queue_limits_and_failed_generation_are_visible(client, session, tmp_path, monkeypatch):
    from app.core.config import settings
    from app.modules.miniapp import report_render

    monkeypatch.setattr(settings, "file_storage_root", str(tmp_path))
    a, _b, user = setup(session)
    client.cookies.clear()
    headers = {"authorization": "Bearer " + make_token(user)}
    for _ in range(2):
        session.add(
            FinancialReportExport(
                user_id=user.id,
                store_id=a.id,
                period="2026-10",
                status="pending",
                expires_at=utc_now() + timedelta(hours=1),
            )
        )
    session.commit()
    assert (
        client.post(
            "/api/miniapp/report-exports",
            json={"store_id": a.id, "period": "2026-10"},
            headers=headers,
        ).status_code
        == 429
    )
    for row in session.query(FinancialReportExport).all():
        row.status = "failed"
    session.commit()

    def broken(*args):
        raise ValueError("simulated render failure")

    monkeypatch.setattr(report_render, "pdf", broken)
    created = client.post(
        "/api/miniapp/report-exports", json={"store_id": a.id, "period": "2026-10"}, headers=headers
    )
    assert created.status_code == 200, created.text
    job_id = created.json()["data"]["id"]
    status = client.get("/api/miniapp/report-exports/" + job_id, headers=headers).json()["data"]
    assert status["status"] == "failed" and status["error"]
    assert (
        client.get(
            "/api/miniapp/report-exports/" + job_id + "/download", headers=headers
        ).status_code
        == 409
    )
    assert not (tmp_path / "report_exports" / job_id).exists()


def test_render_money_percent_and_html_escaping():
    from app.modules.miniapp.report_render import cash, percent

    assert cash("-123.45") == "-¥123.45"
    assert percent("9", "800") == "1.13%"
    assert percent("1", "0") == "—"
