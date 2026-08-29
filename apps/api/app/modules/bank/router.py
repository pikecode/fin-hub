import csv
import io
from datetime import datetime
from decimal import Decimal, InvalidOperation
from collections.abc import Iterable

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from openpyxl import load_workbook
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.models import BankTransaction, Ledger, LedgerStatus, SyncJob, SyncJobStatus, User, UserRole, utc_now
from app.modules.audit.service import write_audit_log
from app.modules.auth.router import audit_actor, require_roles
from app.modules.common import paginate
from app.schemas import (
    ApiEnvelope,
    BankImportPreviewResult,
    BankImportPreviewRow,
    BankImportResult,
    BankImportRowError,
    BankTransactionCreate,
    BankTransactionRead,
    BankTransactionUpdate,
    Page,
)

router = APIRouter(prefix="/bank-transactions", tags=["bank"])


def ensure_open_ledger(session: Session, store_id: str, period: str) -> None:
    ledger = session.scalar(select(Ledger).where(Ledger.store_id == store_id, Ledger.period == period))
    if ledger is None:
        raise HTTPException(status_code=404, detail="Ledger not found")
    if ledger.status == LedgerStatus.CLOSED.value:
        raise HTTPException(status_code=409, detail="Ledger is closed")


@router.get("", response_model=ApiEnvelope[Page[BankTransactionRead]])
def list_bank_transactions(
    store_id: str | None = None,
    ledger_period: str | None = None,
    direction: str | None = None,
    page: int = 1,
    page_size: int = 50,
    session: Session = Depends(get_session),
) -> ApiEnvelope[Page[BankTransactionRead]]:
    query = select(BankTransaction).order_by(BankTransaction.occurred_at.desc())
    if store_id:
        query = query.where(BankTransaction.store_id == store_id)
    if ledger_period:
        query = query.where(BankTransaction.ledger_period == ledger_period)
    if direction:
        query = query.where(BankTransaction.direction == direction)
    items, total = paginate(session, query, page, page_size)
    return ApiEnvelope(data=Page(items=items, total=total, page=page, page_size=page_size))


@router.post("", response_model=ApiEnvelope[BankTransactionRead], status_code=201)
def create_bank_transaction(
    payload: BankTransactionCreate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_roles(UserRole.ADMIN, UserRole.FINANCE)),
) -> ApiEnvelope[BankTransactionRead]:
    ensure_open_ledger(session, payload.store_id, payload.ledger_period)
    transaction = BankTransaction(**payload.model_dump())
    session.add(transaction)
    session.flush()
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="bank_transaction.create",
        resource_type="bank_transaction",
        resource_id=transaction.id,
        summary=f"新增银行流水：{transaction.amount}",
        metadata={
            "store_id": transaction.store_id,
            "ledger_period": transaction.ledger_period,
            "direction": transaction.direction,
        },
    )
    session.commit()
    session.refresh(transaction)
    return ApiEnvelope(data=transaction)


@router.patch("/{transaction_id}", response_model=ApiEnvelope[BankTransactionRead])
def update_bank_transaction(
    transaction_id: str,
    payload: BankTransactionUpdate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_roles(UserRole.ADMIN, UserRole.FINANCE)),
) -> ApiEnvelope[BankTransactionRead]:
    transaction = session.get(BankTransaction, transaction_id)
    if transaction is None:
        raise HTTPException(status_code=404, detail="Bank transaction not found")
    ensure_open_ledger(session, transaction.store_id, transaction.ledger_period)

    updates = payload.model_dump(exclude_unset=True)
    new_amount = updates.get("amount")
    if new_amount is not None and Decimal(new_amount) < Decimal(transaction.matched_amount or 0):
        raise HTTPException(status_code=409, detail="Amount cannot be lower than matched amount")

    new_serial_no = updates.get("bank_serial_no")
    if new_serial_no:
        exists = session.scalar(
            select(BankTransaction).where(
                BankTransaction.bank_serial_no == new_serial_no,
                BankTransaction.id != transaction_id,
            )
        )
        if exists is not None:
            raise HTTPException(status_code=409, detail="Bank serial number already exists")

    for field, value in updates.items():
        setattr(transaction, field, value)

    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="bank_transaction.update",
        resource_type="bank_transaction",
        resource_id=transaction.id,
        summary=f"更新银行流水：{transaction.amount}",
        metadata={
            "store_id": transaction.store_id,
            "ledger_period": transaction.ledger_period,
            "updated_fields": sorted(updates.keys()),
        },
    )
    session.commit()
    session.refresh(transaction)
    return ApiEnvelope(data=transaction)


def pick(row: dict[str, str | None], *names: str) -> str:
    for name in names:
        value = row.get(name)
        if value is not None and value.strip():
            return value.strip()
    return ""


def parse_direction(value: str) -> str:
    normalized = value.strip().lower()
    if normalized in {"income", "in", "收入", "入账", "收款"}:
        return "income"
    if normalized in {"expense", "out", "支出", "出账", "付款"}:
        return "expense"
    raise ValueError(f"Unsupported direction: {value}")


def parse_datetime(value: str) -> datetime:
    for pattern in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d", "%Y/%m/%d %H:%M:%S", "%Y/%m/%d"):
        try:
            return datetime.strptime(value, pattern)
        except ValueError:
            continue
    return datetime.fromisoformat(value)


def transaction_exists(session: Session, payload: dict) -> bool:
    serial_no = payload.get("bank_serial_no")
    if serial_no:
        exists = session.scalar(select(BankTransaction).where(BankTransaction.bank_serial_no == serial_no))
        return exists is not None
    exists = session.scalar(
        select(BankTransaction).where(
            BankTransaction.store_id == payload["store_id"],
            BankTransaction.ledger_period == payload["ledger_period"],
            BankTransaction.occurred_at == payload["occurred_at"],
            BankTransaction.direction == payload["direction"],
            BankTransaction.amount == payload["amount"],
            BankTransaction.counterparty_name == payload.get("counterparty_name"),
        )
    )
    return exists is not None


def parse_import_payload(row: dict[str, str | None], store_id: str, ledger_period: str) -> dict:
    amount_text = pick(row, "amount", "金额", "交易金额")
    return {
        "store_id": store_id,
        "ledger_period": ledger_period,
        "occurred_at": parse_datetime(pick(row, "occurred_at", "发生时间", "交易时间", "日期")),
        "direction": parse_direction(pick(row, "direction", "方向", "收支方向")),
        "amount": Decimal(amount_text.replace(",", "")),
        "counterparty_name": pick(row, "counterparty_name", "对方户名", "交易对方") or None,
        "counterparty_account": pick(row, "counterparty_account", "对方账号") or None,
        "summary": pick(row, "summary", "摘要", "备注") or None,
        "bank_serial_no": pick(row, "bank_serial_no", "流水号", "交易流水号") or None,
    }


def read_import_rows(file_name: str | None, content: bytes) -> Iterable[tuple[int, dict[str, str | None]]]:
    lower_name = (file_name or "").lower()
    if lower_name.endswith((".xlsx", ".xlsm")):
        workbook = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
        sheet = workbook.active
        rows = sheet.iter_rows(values_only=True)
        headers = [str(value).strip() if value is not None else "" for value in next(rows, ())]
        if not any(headers):
            raise HTTPException(status_code=400, detail="XLSX header is required")
        for index, values in enumerate(rows, start=2):
            yield index, {
                headers[column_index]: str(value).strip() if value is not None else None
                for column_index, value in enumerate(values)
                if column_index < len(headers) and headers[column_index]
            }
        workbook.close()
        return

    if lower_name.endswith(".csv") or not lower_name:
        text = content.decode("utf-8-sig")
        reader = csv.DictReader(io.StringIO(text))
        if not reader.fieldnames:
            raise HTTPException(status_code=400, detail="CSV header is required")
        for index, row in enumerate(reader, start=2):
            yield index, row
        return

    raise HTTPException(status_code=400, detail="Only CSV and XLSX files are supported")


async def preview_bank_transactions_file(
    store_id: str = Form(...),
    ledger_period: str = Form(...),
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
    _: User = Depends(require_roles(UserRole.ADMIN, UserRole.FINANCE)),
) -> ApiEnvelope[BankImportPreviewResult]:
    ensure_open_ledger(session, store_id, ledger_period)
    content = await file.read()

    duplicate_count = 0
    row_errors: list[BankImportRowError] = []
    preview_rows: list[BankImportPreviewRow] = []
    for index, row in read_import_rows(file.filename, content):
        try:
            payload = parse_import_payload(row, store_id, ledger_period)
            duplicate = transaction_exists(session, payload)
            if duplicate:
                duplicate_count += 1
            preview_rows.append(
                BankImportPreviewRow(
                    row_number=index,
                    occurred_at=payload["occurred_at"],
                    direction=payload["direction"],
                    amount=payload["amount"],
                    counterparty_name=payload["counterparty_name"],
                    counterparty_account=payload["counterparty_account"],
                    summary=payload["summary"],
                    bank_serial_no=payload["bank_serial_no"],
                    duplicate=duplicate,
                )
            )
        except (ValueError, InvalidOperation) as exc:
            row_errors.append(BankImportRowError(row_number=index, message=str(exc)))

    return ApiEnvelope(
        data=BankImportPreviewResult(
            valid_count=len(preview_rows) - duplicate_count,
            duplicate_count=duplicate_count,
            error_count=len(row_errors),
            preview_rows=preview_rows[:20],
            row_errors=row_errors,
        )
    )


async def import_bank_transactions_file(
    store_id: str = Form(...),
    ledger_period: str = Form(...),
    started_by: str = Form("admin"),
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
    current_user: User = Depends(require_roles(UserRole.ADMIN, UserRole.FINANCE)),
) -> ApiEnvelope[BankImportResult]:
    ensure_open_ledger(session, store_id, ledger_period)
    content = await file.read()

    job = SyncJob(
        job_type="bank_transaction_import",
        status=SyncJobStatus.RUNNING.value,
        started_by=audit_actor(current_user, started_by),
        started_at=utc_now(),
    )
    session.add(job)
    session.flush()

    created_count = 0
    skipped_count = 0
    row_errors: list[BankImportRowError] = []
    try:
        for index, row in read_import_rows(file.filename, content):
            job.processed_count += 1
            try:
                payload = parse_import_payload(row, store_id, ledger_period)
                if transaction_exists(session, payload):
                    skipped_count += 1
                    continue
                session.add(BankTransaction(**payload))
                created_count += 1
            except (ValueError, InvalidOperation) as exc:
                row_errors.append(BankImportRowError(row_number=index, message=str(exc)))
                job.failed_count += 1
                job.error_message = "; ".join(
                    f"Row {error.row_number}: {error.message}" for error in row_errors[:5]
                )
        job.success_count = created_count
        job.failed_count += skipped_count
        job.status = SyncJobStatus.SUCCEEDED.value if not job.error_message else SyncJobStatus.FAILED.value
        job.finished_at = utc_now()
        write_audit_log(
            session,
            actor=audit_actor(current_user, started_by),
            action="bank_transaction.import_csv",
            resource_type="sync_job",
            resource_id=job.id,
            summary=f"导入银行流水：新增 {created_count} 条，跳过 {skipped_count} 条",
            metadata={"store_id": store_id, "ledger_period": ledger_period, "file_name": file.filename},
        )
        session.commit()
        session.refresh(job)
    except Exception:
        job.status = SyncJobStatus.FAILED.value
        job.finished_at = utc_now()
        session.commit()
        raise

    return ApiEnvelope(
        data=BankImportResult(
            job=job,
            created_count=created_count,
            skipped_count=skipped_count,
            row_errors=row_errors,
        )
    )


router.post("/import/preview", response_model=ApiEnvelope[BankImportPreviewResult])(
    preview_bank_transactions_file
)
router.post("/import", response_model=ApiEnvelope[BankImportResult], status_code=201)(
    import_bank_transactions_file
)
router.post("/import-csv", response_model=ApiEnvelope[BankImportResult], status_code=201)(
    import_bank_transactions_file
)
