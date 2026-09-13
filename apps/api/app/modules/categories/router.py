from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import case, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.models import ExpenseCategory, User
from app.modules.audit.service import write_audit_log
from app.modules.auth.permissions import ensure_permission
from app.modules.auth.router import audit_actor, get_current_user
from app.modules.common import paginate
from app.schemas import (
    ApiEnvelope,
    ExpenseCategoryCreate,
    ExpenseCategoryRead,
    ExpenseCategoryUpdate,
    Page,
)

router = APIRouter(prefix="/categories", tags=["categories"])
REVENUE_FEE_CATEGORY_L1 = "手续费"
FOOD_COST_CATEGORY_L1 = "食材成本"
SYSTEM_ROOT_CATEGORY_NAMES = {REVENUE_FEE_CATEGORY_L1, FOOD_COST_CATEGORY_L1}


def is_revenue_fee_category(session: Session, category: ExpenseCategory) -> bool:
    if category.parent_id is None:
        return category.name == REVENUE_FEE_CATEGORY_L1
    parent = session.get(ExpenseCategory, category.parent_id)
    return parent is not None and parent.name == REVENUE_FEE_CATEGORY_L1 and parent.parent_id is None


def ensure_category_is_not_revenue_fee(session: Session, category: ExpenseCategory) -> None:
    if is_revenue_fee_category(session, category):
        raise HTTPException(status_code=409, detail="手续费分类由营业收入渠道自动维护，不能编辑或停用")


def ensure_category_root_is_not_system_metric(category: ExpenseCategory) -> None:
    if category.parent_id is None and category.name == FOOD_COST_CATEGORY_L1:
        raise HTTPException(status_code=409, detail="食材成本是毛利计算口径，不能编辑或停用")


def ensure_parent_is_not_revenue_fee(session: Session, parent_id: str | None) -> None:
    if parent_id is None:
        return
    parent = session.get(ExpenseCategory, parent_id)
    if parent is not None and parent.parent_id is None and parent.name == REVENUE_FEE_CATEGORY_L1:
        raise HTTPException(status_code=409, detail="手续费子分类由营业收入渠道自动维护，不能手工新增")


@router.get("", response_model=ApiEnvelope[Page[ExpenseCategoryRead]])
def list_categories(
    parent_id: str | None = None,
    page: int = 1,
    page_size: int = 100,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[Page[ExpenseCategoryRead]]:
    ensure_permission(session, current_user, "categories.view")
    query = select(ExpenseCategory).order_by(
        case((ExpenseCategory.status == "inactive", 1), else_=0),
        ExpenseCategory.sort_order.asc(),
        ExpenseCategory.created_at.asc(),
    )
    if parent_id is not None:
        query = query.where(ExpenseCategory.parent_id == parent_id)
    items, total = paginate(session, query, page, page_size)
    return ApiEnvelope(data=Page(items=items, total=total, page=page, page_size=page_size))


@router.post("", response_model=ApiEnvelope[ExpenseCategoryRead], status_code=201)
def create_category(
    payload: ExpenseCategoryCreate,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[ExpenseCategoryRead]:
    ensure_permission(session, current_user, "categories.manage")
    if payload.parent_id is not None and session.get(ExpenseCategory, payload.parent_id) is None:
        raise HTTPException(status_code=404, detail="Parent category not found")
    if payload.parent_id is None and payload.name in SYSTEM_ROOT_CATEGORY_NAMES:
        raise HTTPException(status_code=409, detail=f"{payload.name}是系统分类，不能手工新增")
    ensure_parent_is_not_revenue_fee(session, payload.parent_id)
    exists = session.scalar(
        select(ExpenseCategory).where(
            ExpenseCategory.name == payload.name,
        )
    )
    if exists is not None:
        raise HTTPException(status_code=409, detail="分类名称已存在")

    category = ExpenseCategory(**payload.model_dump())
    session.add(category)
    try:
        session.flush()
        write_audit_log(
            session,
            actor=audit_actor(current_user),
            action="category.create",
            resource_type="expense_category",
            resource_id=category.id,
            summary=f"新增费用分类：{category.name}",
            metadata={"parent_id": category.parent_id},
        )
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(status_code=409, detail="分类名称已存在") from exc
    session.refresh(category)
    return ApiEnvelope(data=category)


@router.patch("/{category_id}", response_model=ApiEnvelope[ExpenseCategoryRead])
def update_category(
    category_id: str,
    payload: ExpenseCategoryUpdate,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[ExpenseCategoryRead]:
    ensure_permission(session, current_user, "categories.manage")
    category = session.get(ExpenseCategory, category_id)
    if category is None:
        raise HTTPException(status_code=404, detail="Category not found")
    ensure_category_is_not_revenue_fee(session, category)
    ensure_category_root_is_not_system_metric(category)

    changes = payload.model_dump(exclude_unset=True)
    parent_id = changes.get("parent_id", category.parent_id)
    name = changes.get("name", category.name)
    if parent_id == category.id:
        raise HTTPException(status_code=409, detail="Category cannot be its own parent")
    if parent_id is not None and session.get(ExpenseCategory, parent_id) is None:
        raise HTTPException(status_code=404, detail="Parent category not found")
    if parent_id is None and name in SYSTEM_ROOT_CATEGORY_NAMES:
        raise HTTPException(status_code=409, detail=f"{name}是系统分类，不能手工新增")
    ensure_parent_is_not_revenue_fee(session, parent_id)
    exists = session.scalar(
        select(ExpenseCategory).where(
            ExpenseCategory.id != category.id,
            ExpenseCategory.name == name,
        )
    )
    if exists is not None:
        raise HTTPException(status_code=409, detail="分类名称已存在")

    for field, value in changes.items():
        setattr(category, field, value)
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="category.update",
        resource_type="expense_category",
        resource_id=category.id,
        summary=f"更新费用分类：{category.name}",
        metadata=changes,
    )
    session.commit()
    session.refresh(category)
    return ApiEnvelope(data=category)
