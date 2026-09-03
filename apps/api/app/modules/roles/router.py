from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.models import Role, RolePermission, RolePermissionSetting, User, UserRole
from app.modules.audit.service import write_audit_log
from app.modules.auth.permissions import (
    ALL_PERMISSIONS,
    ROLE_DEFAULT_PERMISSIONS,
    ensure_builtin_roles,
    list_roles,
    validate_permissions,
)
from app.modules.auth.router import audit_actor, require_permission
from app.schemas import ApiEnvelope, RoleCreate, RolePermissionRead, RolePermissionUpdate, RoleRead, RoleUpdate

router = APIRouter(prefix="/roles", tags=["roles"])


def get_role_row(session: Session, role_key: str) -> Role | None:
    ensure_builtin_roles(session)
    return session.scalar(select(Role).where(Role.key == role_key))


def role_permission_snapshot(session: Session, role: str) -> list[str]:
    if role == UserRole.ADMIN.value:
        return list(ALL_PERMISSIONS)
    setting = session.get(RolePermissionSetting, role)
    if setting is None or not setting.permissions_configured:
        return sorted(ROLE_DEFAULT_PERMISSIONS.get(role, set()))
    permissions = sorted(
        session.scalars(select(RolePermission.permission).where(RolePermission.role == role))
    )
    return permissions


def serialize_role(session: Session, role: Role) -> RoleRead:
    return RoleRead(
        id=role.id,
        key=role.key,
        name=role.name,
        sort_order=role.sort_order,
        is_system=role.is_system,
        is_admin=role.key == UserRole.ADMIN.value,
        permissions=role_permission_snapshot(session, role.key),
        created_at=role.created_at,
        updated_at=role.updated_at,
    )


@router.get("", response_model=ApiEnvelope[list[RoleRead]])
def list_roles_endpoint(
    session: Session = Depends(get_session),
    _: User = Depends(require_permission("users.manage")),
) -> ApiEnvelope[list[RoleRead]]:
    return ApiEnvelope(data=[serialize_role(session, role) for role in list_roles(session)])


@router.post("", response_model=ApiEnvelope[RoleRead], status_code=201)
def create_role(
    payload: RoleCreate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("users.manage")),
) -> ApiEnvelope[RoleRead]:
    existing = get_role_row(session, payload.key)
    if existing is not None:
        raise HTTPException(status_code=409, detail="Role key already exists")
    role = Role(key=payload.key, name=payload.name, sort_order=payload.sort_order, is_system=False)
    session.add(role)
    session.flush()
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="role.create",
        resource_type="role",
        resource_id=role.key,
        summary=f"新增角色：{role.name}",
        metadata={"key": role.key, "sort_order": role.sort_order},
    )
    session.commit()
    session.refresh(role)
    return ApiEnvelope(data=serialize_role(session, role))


@router.patch("/{role_key}", response_model=ApiEnvelope[RoleRead])
def update_role(
    role_key: str,
    payload: RoleUpdate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("users.manage")),
) -> ApiEnvelope[RoleRead]:
    role = get_role_row(session, role_key)
    if role is None:
        raise HTTPException(status_code=404, detail="Role not found")
    if role.is_system and role.key == UserRole.ADMIN.value:
        changes = payload.model_dump(exclude_unset=True)
        if "name" in changes or "sort_order" in changes:
            raise HTTPException(status_code=400, detail="System role cannot be renamed")
    changes = payload.model_dump(exclude_unset=True)
    for field, value in changes.items():
        setattr(role, field, value)
    if changes:
        write_audit_log(
            session,
            actor=audit_actor(current_user),
            action="role.update",
            resource_type="role",
            resource_id=role.key,
            summary=f"更新角色：{role.name}",
            metadata=changes,
        )
    session.commit()
    session.refresh(role)
    return ApiEnvelope(data=serialize_role(session, role))


@router.delete("/{role_key}", response_model=ApiEnvelope[dict[str, bool]])
def delete_role(
    role_key: str,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("users.manage")),
) -> ApiEnvelope[dict[str, bool]]:
    role = get_role_row(session, role_key)
    if role is None:
        raise HTTPException(status_code=404, detail="Role not found")
    if role.is_system:
        raise HTTPException(status_code=400, detail="System role cannot be deleted")
    has_users = session.scalar(select(User.id).where(User.role == role.key)) is not None
    if has_users:
        raise HTTPException(status_code=409, detail="Role is assigned to users")
    session.execute(delete(RolePermission).where(RolePermission.role == role.key))
    setting = session.get(RolePermissionSetting, role.key)
    if setting is not None:
        session.delete(setting)
    session.delete(role)
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="role.delete",
        resource_type="role",
        resource_id=role.key,
        summary=f"删除角色：{role.name}",
    )
    session.commit()
    return ApiEnvelope(data={"ok": True})


@router.get("/permissions", response_model=ApiEnvelope[list[RolePermissionRead]])
def list_role_permissions(
    session: Session = Depends(get_session),
    _: User = Depends(require_permission("users.manage")),
) -> ApiEnvelope[list[RolePermissionRead]]:
    roles = list_roles(session)
    return ApiEnvelope(data=[RolePermissionRead(role=role.key, permissions=role_permission_snapshot(session, role.key)) for role in roles])


@router.put("/{role}/permissions", response_model=ApiEnvelope[RolePermissionRead])
def update_role_permissions(
    role: str,
    payload: RolePermissionUpdate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("users.manage")),
) -> ApiEnvelope[RolePermissionRead]:
    ensure_builtin_roles(session)
    role_row = session.scalar(select(Role).where(Role.key == role))
    if role_row is None:
        raise HTTPException(status_code=404, detail="Role not found")
    if role_row.is_system and role_row.key == UserRole.ADMIN.value:
        raise HTTPException(status_code=400, detail="Admin role permissions are fixed")
    validate_permissions(payload.permissions)
    setting = session.get(RolePermissionSetting, role_row.key)
    if setting is None:
        setting = RolePermissionSetting(role=role_row.key, permissions_configured=True)
        session.add(setting)
    else:
        setting.permissions_configured = True
    session.execute(delete(RolePermission).where(RolePermission.role == role_row.key))
    for permission in sorted(set(payload.permissions)):
        session.add(RolePermission(role=role_row.key, permission=permission))
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="role.permissions.update",
        resource_type="role",
        resource_id=role_row.key,
        summary=f"更新角色权限：{role_row.name}",
        metadata={"permissions": payload.permissions},
    )
    session.commit()
    return ApiEnvelope(data=RolePermissionRead(role=role_row.key, permissions=role_permission_snapshot(session, role_row.key)))
