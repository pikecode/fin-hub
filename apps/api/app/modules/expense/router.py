import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.models import ExpenseItem, Ledger, LedgerStatus, User, UserRole
from app.modules.audit.service import write_audit_log
from app.modules.auth.router import audit_actor, require_roles
from app.modules.common import paginate
from app.schemas import ApiEnvelope, ExpenseItemCreate, ExpenseItemRead, ExpenseItemUpdate, Page

router = APIRouter(prefix="/expense-items", tags=["expense"])


def ensure_open_ledger(session: Session, store_id: str, period: str) -> None:
    ledger = session.scalar(select(Ledger).where(Ledger.store_id == store_id, Ledger.period == period))
    if ledger is None:
        raise HTTPException(status_code=404, detail="Ledger not found")
    if ledger.status == LedgerStatus.CLOSED.value:
        raise HTTPException(status_code=409, detail="Ledger is closed")


@router.get("", response_model=ApiEnvelope[Page[ExpenseItemRead]])
def list_expense_items(
    store_id: str | None = None,
    ledger_period: str | None = None,
    approval_instance_id: str | None = None,
    payment_status: str | None = None,
    page: int = 1,
    page_size: int = 50,
    session: Session = Depends(get_session),
) -> ApiEnvelope[Page[ExpenseItemRead]]:
    query = select(ExpenseItem).order_by(ExpenseItem.created_at.desc())
    if store_id:
        query = query.where(ExpenseItem.store_id == store_id)
    if ledger_period:
        query = query.where(ExpenseItem.ledger_period == ledger_period)
    if approval_instance_id:
        query = query.where(ExpenseItem.approval_instance_id == approval_instance_id)
    if payment_status:
        payment_statuses = [status.strip() for status in payment_status.split(",") if status.strip()]
        if len(payment_statuses) == 1:
            query = query.where(ExpenseItem.payment_status == payment_statuses[0])
        elif payment_statuses:
            query = query.where(ExpenseItem.payment_status.in_(payment_statuses))
    items, total = paginate(session, query, page, page_size)
    return ApiEnvelope(data=Page(items=items, total=total, page=page, page_size=page_size))


@router.post("", response_model=ApiEnvelope[ExpenseItemRead], status_code=201)
def create_expense_item(
    payload: ExpenseItemCreate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_roles(UserRole.ADMIN, UserRole.FINANCE)),
) -> ApiEnvelope[ExpenseItemRead]:
    ensure_open_ledger(session, payload.store_id, payload.ledger_period)
    item = ExpenseItem(**payload.model_dump())
    session.add(item)
    session.flush()
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="expense_item.create",
        resource_type="expense_item",
        resource_id=item.id,
        summary=f"新增支出：{item.description}",
        metadata={"store_id": item.store_id, "ledger_period": item.ledger_period, "amount": item.amount},
    )
    session.commit()
    session.refresh(item)
    return ApiEnvelope(data=item)


@router.patch("/{item_id}", response_model=ApiEnvelope[ExpenseItemRead])
def update_expense_item(
    item_id: str,
    payload: ExpenseItemUpdate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_roles(UserRole.ADMIN, UserRole.FINANCE)),
) -> ApiEnvelope[ExpenseItemRead]:
    item = session.get(ExpenseItem, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Expense item not found")

    ensure_open_ledger(session, item.store_id, item.ledger_period)
    changes = payload.model_dump(exclude_unset=True)
    for field, value in changes.items():
        setattr(item, field, value)
    if item.source == "dingtalk" and changes:
        edited_fields: set[str] = set()
        if item.user_edited_fields_json:
            try:
                decoded = json.loads(item.user_edited_fields_json)
                if isinstance(decoded, list):
                    edited_fields = {str(field) for field in decoded}
            except ValueError:
                edited_fields = set()
        item.user_edited_fields_json = json.dumps(
            sorted(edited_fields | set(changes.keys())),
            ensure_ascii=False,
        )

    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="expense_item.update",
        resource_type="expense_item",
        resource_id=item.id,
        summary=f"更新支出：{item.description}",
        metadata=changes,
    )
    session.commit()
    session.refresh(item)
    return ApiEnvelope(data=item)
