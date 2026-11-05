"""Read-only checks of persisted approval store assignments."""

from sqlalchemy import func, or_, select

from app.models import ExpenseItem, Store, TemplateFieldMapping


def approval_store_issues(session, instances):
    from app.modules.dingtalk.router import (
        approval_raw_payload,
        form_value_map,
        mapped_or_form_value,
        mapped_value,
        parse_text,
        resolve_store,
    )

    if not instances:
        return {}
    stores = {row.id: row for row in session.scalars(select(Store))}
    mappings = {}
    for mapping in session.scalars(
        select(TemplateFieldMapping).where(
            TemplateFieldMapping.template_id.in_({row.template_id for row in instances})
        )
    ):
        mappings.setdefault(mapping.template_id, []).append(mapping)
    ids = {row.id for row in instances}
    source_ids = {row.dingtalk_instance_id: row.id for row in instances}
    expenses = {}
    # Include legacy source-document association as well as the explicit FK.
    for item in session.scalars(
        select(ExpenseItem).where(
            or_(
                ExpenseItem.approval_instance_id.in_(ids),
                (ExpenseItem.approval_instance_id.is_(None))
                & (ExpenseItem.source == "dingtalk")
                & func.split_part(ExpenseItem.source_document_id, ":", 1).in_(list(source_ids)),
            )
        )
    ):
        approval_id = item.approval_instance_id or source_ids.get(
            (item.source_document_id or "").split(":", 1)[0]
        )
        if approval_id in ids:
            expenses.setdefault(approval_id, set()).add(item.store_id)
    resolved = {}

    def resolve(value):
        if not value:
            return None
        if value not in resolved:
            resolved[value] = resolve_store(session, value)
        return resolved[value]

    result = {}
    for row in instances:
        reasons = []
        current = stores.get(row.store_id)
        if not current:
            reasons.append("未关联有效门店")
        if any(
            store_id != row.store_id or store_id is None for store_id in expenses.get(row.id, set())
        ):
            reasons.append("审批与费用明细落库门店不一致")
        if row.manual_store_id:
            if row.manual_store_id != row.store_id or row.manual_store_id not in stores:
                reasons.append("人工指定门店与落库门店不一致")
        else:
            raw = approval_raw_payload(row)
            values = form_value_map(raw)
            mapped = {
                m.standard_field: mapped_value(m, values, raw)
                for m in mappings.get(row.template_id, [])
            }
            source = parse_text(
                mapped_or_form_value(
                    mapped, raw, "store", "支出门店", "门店", "费用门店", "所属门店", "报销门店"
                )
            ) or parse_text(mapped.get("store_name"))
            expected = (
                resolve(source)
                if source
                else (
                    resolve(
                        parse_text(raw.get("originator_dept_id") or raw.get("originatorDeptId"))
                    )
                    or resolve(
                        parse_text(raw.get("originator_dept_name") or raw.get("originatorDeptName"))
                    )
                )
            )
            if source and not expected:
                reasons.append("来源门店无法识别，请核对")
            elif expected and expected.id != row.store_id:
                reasons.append(f"来源门店为{expected.name}，与落库门店不一致")
        if reasons:
            result[row.id] = "；".join(reasons)
    return result
