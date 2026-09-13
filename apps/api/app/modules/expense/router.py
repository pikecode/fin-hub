import json

from fastapi import APIRouter, Depends, HTTPException
from datetime import date
from decimal import Decimal

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.models import Attachment, ApprovalInstance, ExpenseCategory, ExpenseItem, ExpensePaymentStatus, Ledger, LedgerStatus, MasterDataStatus, User
from app.modules.approvals.status import refresh_approval_processing_status
from app.modules.audit.service import write_audit_log
from app.modules.auth.router import audit_actor, require_permission
from app.modules.common import paginate
from app.schemas import ApiEnvelope, ExpenseItemCreate, ExpenseItemRead, ExpenseItemUpdate, KuailvPurchaseCreate, KuailvPurchaseRead, KuailvPurchaseUpdate, Page

router = APIRouter(prefix="/expense-items", tags=["expense"])
KUAILV_PURCHASE_SOURCE = "kuailv_purchase"
FOOD_COST_CATEGORY_L1 = "食材成本"
KUAILV_PURCHASE_CATEGORY_L2 = "快驴采购"


def ensure_open_ledger(session: Session, store_id: str, period: str) -> None:
    ledger = session.scalar(select(Ledger).where(Ledger.store_id == store_id, Ledger.period == period))
    if ledger is None:
        raise HTTPException(status_code=404, detail="Ledger not found")
    if ledger.status == LedgerStatus.CLOSED.value:
        raise HTTPException(status_code=409, detail="Ledger is closed")


def ensure_open_or_create_ledger(session: Session, store_id: str, period: str) -> None:
    ledger = session.scalar(select(Ledger).where(Ledger.store_id == store_id, Ledger.period == period))
    if ledger is None:
        session.add(Ledger(store_id=store_id, period=period))
        session.flush()
        return
    if ledger.status == LedgerStatus.CLOSED.value:
        raise HTTPException(status_code=409, detail="Ledger is closed")


def ensure_kuailv_purchase_categories(session: Session) -> None:
    parent = session.scalar(
        select(ExpenseCategory).where(
            ExpenseCategory.parent_id.is_(None),
            ExpenseCategory.name == FOOD_COST_CATEGORY_L1,
        )
    )
    if parent is None:
        parent = ExpenseCategory(name=FOOD_COST_CATEGORY_L1, parent_id=None, sort_order=5)
        session.add(parent)
        session.flush()
    if parent.status != MasterDataStatus.ACTIVE.value:
        parent.status = MasterDataStatus.ACTIVE.value

    child = session.scalar(
        select(ExpenseCategory).where(
            ExpenseCategory.parent_id == parent.id,
            ExpenseCategory.name == KUAILV_PURCHASE_CATEGORY_L2,
        )
    )
    if child is None:
        child = ExpenseCategory(name=KUAILV_PURCHASE_CATEGORY_L2, parent_id=parent.id, sort_order=20)
        session.add(child)
    elif child.status != MasterDataStatus.ACTIVE.value:
        child.status = MasterDataStatus.ACTIVE.value


def kuailv_description(purchase_date: date) -> str:
    return f"快驴采购 {purchase_date.isoformat()}"


def kuailv_purchase_read(session: Session, item: ExpenseItem) -> KuailvPurchaseRead:
    attachment_count = session.scalar(
        select(func.count()).select_from(Attachment).where(
            Attachment.resource_type == "expense_item",
            Attachment.resource_id == item.id,
        )
    )
    return KuailvPurchaseRead(
        id=item.id,
        store_id=item.store_id or "",
        ledger_period=item.ledger_period or "",
        purchase_date=item.expense_date,
        amount=Decimal(item.amount),
        remark=item.remark,
        attachment_count=attachment_count or 0,
        created_at=item.created_at,
        updated_at=item.updated_at,
    )


def approval_expense_condition(approval: ApprovalInstance):
    dingtalk_instance_id = approval.dingtalk_instance_id
    return or_(
        ExpenseItem.approval_instance_id == approval.id,
        (
            (ExpenseItem.source == "dingtalk")
            & ExpenseItem.source_document_id.is_not(None)
            & (
                (ExpenseItem.source_document_id == dingtalk_instance_id)
                | ExpenseItem.source_document_id.like(f"{dingtalk_instance_id}:%")
            )
        ),
    )


def resolve_approval_id_for_expense(session: Session, item: ExpenseItem) -> str | None:
    if item.approval_instance_id:
        return item.approval_instance_id
    if item.source != "dingtalk" or not item.source_document_id:
        return None
    dingtalk_instance_id = item.source_document_id.split(":", 1)[0]
    return session.scalar(
        select(ApprovalInstance.id).where(ApprovalInstance.dingtalk_instance_id == dingtalk_instance_id)
    )


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
        approval = session.get(ApprovalInstance, approval_instance_id)
        if approval is None:
            query = query.where(ExpenseItem.approval_instance_id == approval_instance_id)
        else:
            query = query.where(approval_expense_condition(approval))
            has_line_items = (
                select(ExpenseItem.id)
                .where(
                    ExpenseItem.source == "dingtalk",
                    ExpenseItem.source_document_id.like(f"{approval.dingtalk_instance_id}:%"),
                )
                .exists()
            )
            query = query.where(
                or_(
                    ~has_line_items,
                    ExpenseItem.source_document_id != approval.dingtalk_instance_id,
                )
            )
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
    current_user: User = Depends(require_permission("reconciliation.manage")),
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


@router.get("/kuailv-purchases", response_model=ApiEnvelope[list[KuailvPurchaseRead]])
def list_kuailv_purchases(
    store_id: str,
    ledger_period: str,
    session: Session = Depends(get_session),
    _: User = Depends(require_permission("reconciliation.view")),
) -> ApiEnvelope[list[KuailvPurchaseRead]]:
    items = session.scalars(
        select(ExpenseItem)
        .where(
            ExpenseItem.store_id == store_id,
            ExpenseItem.ledger_period == ledger_period,
            ExpenseItem.source == KUAILV_PURCHASE_SOURCE,
        )
        .order_by(ExpenseItem.expense_date.desc(), ExpenseItem.created_at.desc())
    ).all()
    return ApiEnvelope(data=[kuailv_purchase_read(session, item) for item in items])


@router.post("/kuailv-purchases", response_model=ApiEnvelope[KuailvPurchaseRead], status_code=201)
def create_kuailv_purchase(
    payload: KuailvPurchaseCreate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("reconciliation.manage")),
) -> ApiEnvelope[KuailvPurchaseRead]:
    ensure_open_or_create_ledger(session, payload.store_id, payload.ledger_period)
    ensure_kuailv_purchase_categories(session)
    item = ExpenseItem(
        store_id=payload.store_id,
        ledger_period=payload.ledger_period,
        expense_date=payload.purchase_date,
        description=kuailv_description(payload.purchase_date),
        amount=payload.amount,
        category_l1=FOOD_COST_CATEGORY_L1,
        category_l2=KUAILV_PURCHASE_CATEGORY_L2,
        payment_status=ExpensePaymentStatus.NO_BANK_FLOW.value,
        source=KUAILV_PURCHASE_SOURCE,
        source_document_id=None,
        remark=payload.remark,
    )
    session.add(item)
    session.flush()
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="kuailv_purchase.create",
        resource_type="expense_item",
        resource_id=item.id,
        summary=f"新增快驴采购：{payload.purchase_date.isoformat()} {payload.amount}",
        metadata={"store_id": item.store_id, "ledger_period": item.ledger_period, "amount": item.amount},
    )
    session.commit()
    session.refresh(item)
    return ApiEnvelope(data=kuailv_purchase_read(session, item))


def ensure_kuailv_purchase(session: Session, item_id: str) -> ExpenseItem:
    item = session.get(ExpenseItem, item_id)
    if item is None or item.source != KUAILV_PURCHASE_SOURCE:
        raise HTTPException(status_code=404, detail="Kuailv purchase not found")
    return item


@router.patch("/kuailv-purchases/{item_id}", response_model=ApiEnvelope[KuailvPurchaseRead])
def update_kuailv_purchase(
    item_id: str,
    payload: KuailvPurchaseUpdate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("reconciliation.manage")),
) -> ApiEnvelope[KuailvPurchaseRead]:
    item = ensure_kuailv_purchase(session, item_id)
    ensure_open_ledger(session, item.store_id, item.ledger_period)
    ensure_open_or_create_ledger(session, item.store_id, payload.ledger_period)
    item.ledger_period = payload.ledger_period
    item.expense_date = payload.purchase_date
    item.description = kuailv_description(payload.purchase_date)
    item.amount = payload.amount
    item.remark = payload.remark
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="kuailv_purchase.update",
        resource_type="expense_item",
        resource_id=item.id,
        summary=f"更新快驴采购：{payload.purchase_date.isoformat()} {payload.amount}",
        metadata={"store_id": item.store_id, "ledger_period": item.ledger_period, "amount": item.amount},
    )
    session.commit()
    session.refresh(item)
    return ApiEnvelope(data=kuailv_purchase_read(session, item))


@router.delete("/kuailv-purchases/{item_id}", response_model=ApiEnvelope[dict[str, bool]])
def delete_kuailv_purchase(
    item_id: str,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("reconciliation.manage")),
) -> ApiEnvelope[dict[str, bool]]:
    item = ensure_kuailv_purchase(session, item_id)
    ensure_open_ledger(session, item.store_id, item.ledger_period)
    session.query(Attachment).filter(
        Attachment.resource_type == "expense_item",
        Attachment.resource_id == item.id,
    ).delete(synchronize_session=False)
    session.delete(item)
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="kuailv_purchase.delete",
        resource_type="expense_item",
        resource_id=item.id,
        summary=f"删除快驴采购：{item.amount}",
        metadata={"store_id": item.store_id, "ledger_period": item.ledger_period},
    )
    session.commit()
    return ApiEnvelope(data={"ok": True})


@router.patch("/{item_id}", response_model=ApiEnvelope[ExpenseItemRead])
def update_expense_item(
    item_id: str,
    payload: ExpenseItemUpdate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("reconciliation.manage")),
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
        approval_id = resolve_approval_id_for_expense(session, item)
        if approval_id and not item.approval_instance_id:
            item.approval_instance_id = approval_id
        refresh_approval_processing_status(session, approval_id)

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
