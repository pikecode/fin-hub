from fastapi import HTTPException
from sqlalchemy import false, select, true
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.models import (
    RolePermission,
    RolePermissionSetting,
    Role,
    Store,
    User,
    UserRole,
    UserStoreGroupPermission,
    UserStorePermission,
)

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

BUILTIN_ROLES: dict[str, tuple[str, int, bool]] = {
    UserRole.ADMIN.value: ("管理员", 0, True),
    UserRole.FINANCE.value: ("财务", 10, True),
    UserRole.VIEWER.value: ("查看者", 20, True),
}

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
    setting = session.get(RolePermissionSetting, user.role)
    if setting is None or not setting.permissions_configured:
        return expand_permissions(ROLE_DEFAULT_PERMISSIONS.get(user.role, set()))
    assigned = list(
        session.scalars(select(RolePermission.permission).where(RolePermission.role == user.role))
    )
    return expand_permissions(assigned)


def list_roles(session: Session) -> list[Role]:
    ensure_builtin_roles(session)
    return list(session.scalars(select(Role).order_by(Role.sort_order.asc(), Role.created_at.asc())))


def ensure_builtin_roles(session: Session) -> None:
    existing = set(
        session.scalars(
            select(Role.key).where(Role.key.in_(BUILTIN_ROLES.keys()))
        )
    )
    missing = sorted(set(BUILTIN_ROLES) - existing)
    if not missing:
        return
    for key in missing:
        name, sort_order, is_system = BUILTIN_ROLES[key]
        session.add(Role(key=key, name=name, sort_order=sort_order, is_system=is_system))
    session.flush()


def role_exists(session: Session, role_key: str) -> bool:
    ensure_builtin_roles(session)
    return session.scalar(select(Role.id).where(Role.key == role_key)) is not None


def effective_store_ids(session: Session, user: User) -> list[str]:
    if user.role == UserRole.ADMIN.value:
        return sorted(session.scalars(select(Store.id)))
    direct_store_ids = set(
        session.scalars(
            select(UserStorePermission.store_id).where(UserStorePermission.user_id == user.id)
        )
    )
    group_ids = list(
        session.scalars(
            select(UserStoreGroupPermission.group_id).where(
                UserStoreGroupPermission.user_id == user.id
            )
        )
    )
    if group_ids:
        direct_store_ids.update(
            session.scalars(select(Store.id).where(Store.group_id.in_(group_ids)))
        )
    return sorted(direct_store_ids)


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
    return store_id in set(effective_store_ids(session, user))


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
