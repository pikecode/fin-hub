"""Durable export metadata with bounded, recoverable in-process rendering jobs."""

# ruff: noqa: B008 -- FastAPI dependencies are declared in route defaults.

import base64
import json
import logging
import shutil
import threading
from datetime import timedelta
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.encoders import jsonable_encoder
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_session
from app.models import Attachment, FinancialReportExport, User, utc_now
from app.modules.auth.permissions import ensure_permission, ensure_store_access
from app.modules.miniapp.router import mobile_user, readable_period

router = APIRouter(prefix="/miniapp/report-exports", tags=["miniapp"])
_render_slots = threading.BoundedSemaphore(2)


class ExportRequest(BaseModel):
    store_id: str = Field(min_length=1, max_length=32)
    period: str = Field(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")


def root():
    path = Path(settings.file_storage_root) / "report_exports"
    path.mkdir(parents=True, exist_ok=True)
    return path


def authorize_job(session, user, job_id):
    row = session.get(FinancialReportExport, job_id)
    if not row or row.user_id != user.id:
        raise HTTPException(404, "导出任务不存在")
    ensure_store_access(session, user, row.store_id)
    if row.expires_at <= utc_now():
        raise HTTPException(410, "导出文件已过期，请重新生成")
    return row


def describe(row):
    return {
        "id": row.id,
        "store_id": row.store_id,
        "period": row.period,
        "status": row.status,
        "created_at": row.created_at,
        "expires_at": row.expires_at,
        "error": row.error,
        "warnings": json.loads(row.warnings_json or "[]"),
    }


def build_snapshot(session, user, store_id, period):
    from app.modules.miniapp.router import report
    from app.modules.reports.financial import appendix, report_expense_items
    from app.schemas import ExpenseItemRead

    readable_period(session, user, store_id, period)
    data = jsonable_encoder(report(store_id, period, session, user).data)
    data["appendix"] = jsonable_encoder(appendix(store_id, period, session, user).data)
    dates = {r["id"]: r.get("application_date") for r in data["appendix"]["expense_items"]}
    data["appendix"]["expense_items"] = [
        {
            **ExpenseItemRead.model_validate(row).model_dump(mode="json"),
            "application_date": dates.get(row.id) or str(row.expense_date or ""),
        }
        for row in report_expense_items(session, store_id, period)
    ]
    return data


def capture_receipts(session, user, snapshot):
    from app.modules.miniapp.router import attachment

    resources = {
        ("expense_item", r["id"]): r["description"] for r in snapshot["appendix"]["expense_items"]
    }
    resources.update(
        {("expense_item", r["id"]): r["expense_name"] for r in snapshot.get("major_vouchers", [])}
    )
    resources.update(
        {
            ("loan_event", e["id"]): l["borrower"] + " · " + e["date"] + " · " + e["kind"]
            for l in snapshot["supplement"].get("loan_receivables", [])
            for e in l.get("events", [])
            if e.get("active") is not False
        }
    )
    receipts = []
    warnings = []
    size = 0
    deadline = utc_now() + timedelta(minutes=12)
    # Scope is checked again by the shared download service for every attachment.
    for kind, key in sorted(resources):
        rows = session.scalars(
            select(Attachment)
            .where(Attachment.resource_type == kind, Attachment.resource_id == key)
            .order_by(Attachment.id)
        ).all()
        for row in rows:
            if utc_now() > deadline:
                raise ValueError("凭证获取超时，请缩小范围后重试")
            if len(receipts) >= 500:
                raise ValueError("凭证超过500份，请缩小报表范围")
            mime = row.content_type or "application/octet-stream"
            if not mime.startswith("image/"):
                receipts.append(
                    {"name": resources[(kind, key)] + " · " + row.file_name, "mime": mime}
                )
                warnings.append("文件凭证 " + row.file_name + " 请在小程序中查看原件")
                continue
            try:
                response = attachment(row.id, session, user)
                content = (
                    Path(response.path).read_bytes() if hasattr(response, "path") else response.body
                )
                if len(content) > 15 * 1024 * 1024:
                    raise ValueError("图片超过15MB")
                size += len(content)
                if size > 80 * 1024 * 1024:
                    raise ValueError("图片总量超过80MB")
                # Normalize formats and pixel dimensions for portable PDF embedding.
                from io import BytesIO

                from PIL import Image

                with Image.open(BytesIO(content)) as im:
                    im.thumbnail((2200, 2200))
                    im = im.convert("RGB")
                    output = BytesIO()
                    im.save(output, format="JPEG", quality=85)
                receipts.append(
                    {
                        "name": resources[(kind, key)] + " · " + row.file_name,
                        "mime": "image/jpeg",
                        "data": base64.b64encode(output.getvalue()).decode(),
                    }
                )
            except Exception:  # noqa: BLE001 -- Each inaccessible receipt becomes an explicit warning.
                warnings.append("图片凭证 " + row.file_name + " 未能嵌入，请在小程序中核对原件")
    return receipts, warnings


def run_export(job_id, bind):
    from app.modules.miniapp import report_render

    with Session(bind) as session:
        row = session.scalar(
            select(FinancialReportExport)
            .where(FinancialReportExport.id == job_id)
            .with_for_update()
        )
        if not row or row.status != "pending" or row.expires_at <= utc_now():
            return
        row.status = "running"
        row.updated_at = utc_now()
        session.commit()
        user_id, store_id, period = row.user_id, row.store_id, row.period
    with _render_slots:
        try:
            with Session(bind) as session:
                session.connection().exec_driver_sql(
                    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"
                )
                current_job = session.get(FinancialReportExport, job_id)
                if (
                    not current_job
                    or current_job.status != "running"
                    or current_job.expires_at <= utc_now()
                ):
                    return
                user = session.get(User, user_id)
                if not user or user.status != "active":
                    raise ValueError("账号已失效")
                ensure_permission(session, user, "reports.view")
                ensure_store_access(session, user, store_id)
                snapshot = build_snapshot(session, user, store_id, period)
                receipts, warnings = capture_receipts(session, user, snapshot)
            # Both files use exactly the same numeric snapshot and receipt bytes.
            folder = root() / job_id
            folder.mkdir(exist_ok=True)
            html = report_render.html(snapshot, receipts, warnings).encode("utf-8")
            pdf = report_render.pdf(snapshot, receipts, warnings)
            for ext, content in [("html", html), ("pdf", pdf)]:
                path = folder / ("report." + ext + ".tmp")
                path.write_bytes(content)
                path.replace(folder / ("report." + ext))
            with Session(bind) as session:
                row = session.get(FinancialReportExport, job_id)
                if row.status != "running" or row.expires_at <= utc_now():
                    shutil.rmtree(folder, ignore_errors=True)
                    return
                row.snapshot_json = json.dumps(snapshot, ensure_ascii=False)
                row.warnings_json = json.dumps(warnings, ensure_ascii=False)
                row.status = "ready"
                row.updated_at = utc_now()
                session.commit()
        except Exception as exc:  # noqa: BLE001 -- Persist a failed job for any render/storage error.
            logging.getLogger(__name__).warning(
                "report_export_failed job_id=%s kind=%s", job_id, type(exc).__name__
            )
            shutil.rmtree(
                Path(settings.file_storage_root) / "report_exports" / job_id, ignore_errors=True
            )
            with Session(bind) as session:
                row = session.get(FinancialReportExport, job_id)
                if row:
                    row.status = "failed"
                    row.error = "生成失败，请重新生成；如反复失败请联系管理员检查凭证和存储。"
                    row.updated_at = utc_now()
                    session.commit()


@router.post("")
def create_export(
    payload: ExportRequest,
    tasks: BackgroundTasks,
    session: Session = Depends(get_session),
    user: User = Depends(mobile_user),
):
    from app.modules.audit.service import write_audit_log

    readable_period(session, user, payload.store_id, payload.period)
    # Serialize admission across processes and keep waiting background threads bounded.
    session.execute(text("SELECT pg_advisory_xact_lock(2026111301)"))
    session.scalar(select(User.id).where(User.id == user.id).with_for_update())
    for row in session.scalars(
        select(FinancialReportExport).where(FinancialReportExport.expires_at < utc_now()).limit(50)
    ):
        shutil.rmtree(root() / row.id, ignore_errors=True)
        row.snapshot_json = None
        row.status = "expired"
    # Interrupted processes cannot leave tasks appearing to run forever.
    for row in session.scalars(
        select(FinancialReportExport).where(
            FinancialReportExport.status.in_(["pending", "running"]),
            FinancialReportExport.updated_at < utc_now() - timedelta(minutes=15),
        )
    ):
        row.status = "failed"
        row.error = "任务已超时，请重新生成"
    session.flush()
    count = session.scalar(
        select(func.count())
        .select_from(FinancialReportExport)
        .where(
            FinancialReportExport.user_id == user.id,
            FinancialReportExport.status.in_(["pending", "running"]),
        )
    )
    if count >= 2:
        raise HTTPException(429, "最多同时生成2份报表，请等待现有任务完成")
    active = session.scalar(
        select(func.count())
        .select_from(FinancialReportExport)
        .where(FinancialReportExport.status.in_(["pending", "running"]))
    )
    if active >= 8:
        raise HTTPException(429, "导出队列繁忙，请稍后重试")
    row = FinancialReportExport(
        user_id=user.id,
        store_id=payload.store_id,
        period=payload.period,
        expires_at=utc_now() + timedelta(days=1),
    )
    session.add(row)
    session.flush()
    write_audit_log(
        session,
        actor=user.display_name,
        action="report.export.create",
        resource_type="financial_report_export",
        resource_id=row.id,
        summary="生成小程序财务报表",
        metadata={"store_id": row.store_id, "period": row.period},
    )
    session.commit()
    tasks.add_task(run_export, row.id, session.get_bind())
    return {"data": describe(row)}


@router.get("/{job_id}")
def export_status(
    job_id: str,
    tasks: BackgroundTasks,
    session: Session = Depends(get_session),
    user: User = Depends(mobile_user),
):
    row = authorize_job(session, user, job_id)
    if row.status == "pending":
        tasks.add_task(run_export, row.id, session.get_bind())
    elif row.status == "running" and row.updated_at < utc_now() - timedelta(minutes=15):
        row.status = "failed"
        row.error = "任务已中断或超时，请重新生成"
        session.commit()
    return {"data": describe(row)}


@router.get("/{job_id}/download")
def download_export(
    job_id: str,
    format: Literal["pdf", "html"] = Query("pdf"),
    session: Session = Depends(get_session),
    user: User = Depends(mobile_user),
):
    row = authorize_job(session, user, job_id)
    if row.status != "ready":
        raise HTTPException(409, "文件尚未生成成功")
    path = root() / row.id / ("report." + format)
    if not path.is_file():
        raise HTTPException(410, "导出文件已不可用，请重新生成")
    return FileResponse(
        path,
        media_type="application/pdf" if format == "pdf" else "text/html; charset=utf-8",
        filename=f"report-{row.period}.{format}",
    )
