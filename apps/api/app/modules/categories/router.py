from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
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


@router.get("", response_model=ApiEnvelope[Page[ExpenseCategoryRead]])
def list_categories(
    parent_id: str | None = None,
    page: int = 1,
    page_size: int = 100,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[Page[ExpenseCategoryRead]]:
    ensure_permission(session, current_user, "categories.view")
    query = select(ExpenseCategory).order_by(ExpenseCategory.sort_order.asc(), ExpenseCategory.created_at.asc())
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
    exists = session.scalar(
        select(ExpenseCategory).where(
            ExpenseCategory.name == payload.name,
            ExpenseCategory.parent_id == payload.parent_id,
        )
    )
    if exists is not None:
        raise HTTPException(status_code=409, detail="Category already exists")

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
        raise HTTPException(status_code=409, detail="Category already exists") from exc
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

    changes = payload.model_dump(exclude_unset=True)
    parent_id = changes.get("parent_id", category.parent_id)
    name = changes.get("name", category.name)
    if parent_id == category.id:
        raise HTTPException(status_code=409, detail="Category cannot be its own parent")
    if parent_id is not None and session.get(ExpenseCategory, parent_id) is None:
        raise HTTPException(status_code=404, detail="Parent category not found")
    exists = session.scalar(
        select(ExpenseCategory).where(
            ExpenseCategory.id != category.id,
            ExpenseCategory.name == name,
            ExpenseCategory.parent_id == parent_id,
        )
    )
    if exists is not None:
        raise HTTPException(status_code=409, detail="Category already exists")

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
