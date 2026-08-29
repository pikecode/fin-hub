from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.models import Supplier, User, UserRole
from app.modules.audit.service import write_audit_log
from app.modules.auth.router import audit_actor, require_roles
from app.modules.common import paginate
from app.schemas import ApiEnvelope, Page, SupplierCreate, SupplierRead, SupplierUpdate

router = APIRouter(prefix="/suppliers", tags=["suppliers"])


@router.get("", response_model=ApiEnvelope[Page[SupplierRead]])
def list_suppliers(
    page: int = 1,
    page_size: int = 100,
    session: Session = Depends(get_session),
) -> ApiEnvelope[Page[SupplierRead]]:
    query = select(Supplier).order_by(Supplier.created_at.desc())
    items, total = paginate(session, query, page, page_size)
    return ApiEnvelope(data=Page(items=items, total=total, page=page, page_size=page_size))


@router.post("", response_model=ApiEnvelope[SupplierRead], status_code=201)
def create_supplier(
    payload: SupplierCreate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_roles(UserRole.ADMIN, UserRole.FINANCE)),
) -> ApiEnvelope[SupplierRead]:
    supplier = Supplier(**payload.model_dump())
    session.add(supplier)
    try:
        session.flush()
        write_audit_log(
            session,
            actor=audit_actor(current_user),
            action="supplier.create",
            resource_type="supplier",
            resource_id=supplier.id,
            summary=f"新增供应商：{supplier.name}",
        )
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(status_code=409, detail="Supplier already exists") from exc
    session.refresh(supplier)
    return ApiEnvelope(data=supplier)


@router.patch("/{supplier_id}", response_model=ApiEnvelope[SupplierRead])
def update_supplier(
    supplier_id: str,
    payload: SupplierUpdate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_roles(UserRole.ADMIN, UserRole.FINANCE)),
) -> ApiEnvelope[SupplierRead]:
    supplier = session.get(Supplier, supplier_id)
    if supplier is None:
        raise HTTPException(status_code=404, detail="Supplier not found")

    changes = payload.model_dump(exclude_unset=True)
    name = changes.get("name", supplier.name)
    exists = session.scalar(select(Supplier).where(Supplier.id != supplier.id, Supplier.name == name))
    if exists is not None:
        raise HTTPException(status_code=409, detail="Supplier already exists")

    for field, value in changes.items():
        setattr(supplier, field, value)
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="supplier.update",
        resource_type="supplier",
        resource_id=supplier.id,
        summary=f"更新供应商：{supplier.name}",
        metadata=changes,
    )
    session.commit()
    session.refresh(supplier)
    return ApiEnvelope(data=supplier)
