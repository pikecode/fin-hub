from fastapi import HTTPException
from sqlalchemy import false, select, true
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.models import Store, User, UserPermission, UserRole, UserStorePermission

ALL_PERMISSIONS: tuple[str, ...] = (
    "dashboard.view",
    "reconciliation.view",
    "reconciliation.manage",
    "dingtalk.view",
    "dingtalk.manage",
    "reports.view",
    "revenue.view",
    "revenue.manage",
    "stores.view",
    "stores.manage",
    "categories.view",
    "categories.manage",
    "users.view",
    "users.manage",
    "audit.view",
    "settings.manage",
)

ROLE_DEFAULT_PERMISSIONS: dict[str, set[str]] = {
    UserRole.ADMIN.value: set(ALL_PERMISSIONS),
    UserRole.FINANCE.value: {
        "dashboard.view",
        "reconciliation.view",
        "reconciliation.manage",
        "reports.view",
        "revenue.view",
        "revenue.manage",
        "stores.view",
        "stores.manage",
        "categories.view",
        "categories.manage",
        "dingtalk.view",
        "audit.view",
    },
    UserRole.VIEWER.value: {
        "dashboard.view",
        "reconciliation.view",
        "reports.view",
        "revenue.view",
        "stores.view",
        "categories.view",
    },
}

IMPLIED_PERMISSIONS: dict[str, set[str]] = {
    "reconciliation.view": {"stores.view", "categories.view", "dingtalk.view"},
    "reconciliation.manage": {"reconciliation.view"},
    "dingtalk.manage": {"dingtalk.view"},
    "revenue.manage": {"revenue.view", "stores.view"},
    "stores.manage": {"stores.view"},
    "categories.manage": {"categories.view"},
    "users.manage": {"users.view"},
}


def validate_permissions(permissions: list[str]) -> None:
    unknown = sorted(set(permissions) - set(ALL_PERMISSIONS))
    if unknown:
        raise HTTPException(status_code=422, detail=f"Unknown permissions: {', '.join(unknown)}")


def expand_permissions(permissions: list[str] | set[str]) -> list[str]:
    expanded = set(permissions)
    for permission in list(expanded):
        expanded.update(IMPLIED_PERMISSIONS.get(permission, set()))
    return sorted(expanded)


def effective_permissions(session: Session, user: User) -> list[str]:
    if user.role == UserRole.ADMIN.value:
        return list(ALL_PERMISSIONS)
    assigned = list(
        session.scalars(select(UserPermission.permission).where(UserPermission.user_id == user.id))
    )
    if user.permissions_configured:
        return expand_permissions(assigned)
    return expand_permissions(ROLE_DEFAULT_PERMISSIONS.get(user.role, set()))


def effective_store_ids(session: Session, user: User) -> list[str]:
    if user.role == UserRole.ADMIN.value:
        return list(session.scalars(select(Store.id)))
    return list(
        session.scalars(
            select(UserStorePermission.store_id).where(UserStorePermission.user_id == user.id)
        )
    )


def has_permission(session: Session, user: User, permission: str) -> bool:
    return permission in effective_permissions(session, user)


def ensure_permission(session: Session, user: User, permission: str) -> None:
    if not has_permission(session, user, permission):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


def can_access_store(session: Session, user: User, store_id: str | None) -> bool:
    if not store_id:
        return True
    if user.role == UserRole.ADMIN.value:
        return True
    return bool(
        session.scalar(
            select(UserStorePermission.id).where(
                UserStorePermission.user_id == user.id,
                UserStorePermission.store_id == store_id,
            )
        )
    )


def ensure_store_access(session: Session, user: User, store_id: str | None) -> None:
    if not can_access_store(session, user, store_id):
        raise HTTPException(status_code=403, detail="Store is outside user scope")


def scoped_store_condition(session: Session, user: User, column: ColumnElement[str]) -> ColumnElement[bool]:
    if user.role == UserRole.ADMIN.value:
        return true()
    store_ids = effective_store_ids(session, user)
    if not store_ids:
        return false()
    return column.in_(store_ids)
