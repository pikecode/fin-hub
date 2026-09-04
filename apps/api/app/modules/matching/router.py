import json
from datetime import date, datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.models import (
    ApprovalInstance,
    ApprovalTemplate,
    BankTransaction,
    ExpenseBankMatch,
    ExpenseItem,
    ExpensePaymentStatus,
    MasterDataStatus,
    MatchStatus,
    RevenueBankMatch,
    RevenueBankMatchRecord,
    RevenueChannel,
    RevenueRecord,
    TemplateFieldMapping,
    User,
    utc_now,
)
from app.modules.approvals.status import (
    approval_expense_stats,
    approval_expense_stats_map,
    refresh_approval_processing_status,
)
from app.modules.audit.service import write_audit_log
from app.modules.auth.permissions import (
    ensure_permission,
    ensure_store_access,
    scoped_store_condition,
)
from app.modules.auth.router import audit_actor, get_current_user
from app.modules.common import paginate
from app.schemas import (
    ApiEnvelope,
    ApprovalInstanceRead,
    AutoMatchResult,
    MatchCreate,
    MatchRead,
    Page,
    ReconciliationCandidateResult,
    ReconciliationExpenseCandidate,
    ReconciliationRecord,
    ReconciliationRecordUpdate,
    RevenueMatchBatchCreate,
    RevenueMatchCreate,
    RevenueMatchRead,
)

router = APIRouter(prefix="/matches", tags=["matching"])


def ledger_period_bounds(period: str) -> tuple[datetime, datetime]:
    year, month = (int(part) for part in period.split("-", 1))
    start = datetime(year=year, month=month, day=1)
    if month == 12:
        return start, datetime(year=year + 1, month=1, day=1)
    return start, datetime(year=year, month=month + 1, day=1)


def confirmed_expense_match_amount(session: Session, expense_item_id: str, exclude_match_id: str | None = None) -> Decimal:
    query = select(func.coalesce(func.sum(ExpenseBankMatch.amount), Decimal("0.00"))).where(
        ExpenseBankMatch.expense_item_id == expense_item_id,
        ExpenseBankMatch.status == MatchStatus.CONFIRMED.value,
    )
    if exclude_match_id:
        query = query.where(ExpenseBankMatch.id != exclude_match_id)
    return Decimal(session.scalar(query) or 0)


def confirmed_bank_match_amount(session: Session, bank_transaction_id: str, exclude_match_id: str | None = None) -> Decimal:
    query = select(func.coalesce(func.sum(ExpenseBankMatch.amount), Decimal("0.00"))).where(
        ExpenseBankMatch.bank_transaction_id == bank_transaction_id,
        ExpenseBankMatch.status == MatchStatus.CONFIRMED.value,
    )
    if exclude_match_id:
        query = query.where(ExpenseBankMatch.id != exclude_match_id)
    return Decimal(session.scalar(query) or 0)


def active_expense_match_amount(session: Session, expense_item_id: str, exclude_match_id: str | None = None) -> Decimal:
    query = select(func.coalesce(func.sum(ExpenseBankMatch.amount), Decimal("0.00"))).where(
        ExpenseBankMatch.expense_item_id == expense_item_id,
        ExpenseBankMatch.status != MatchStatus.REJECTED.value,
    )
    if exclude_match_id:
        query = query.where(ExpenseBankMatch.id != exclude_match_id)
    return Decimal(session.scalar(query) or 0)


def active_bank_match_amount(session: Session, bank_transaction_id: str, exclude_match_id: str | None = None) -> Decimal:
    query = select(func.coalesce(func.sum(ExpenseBankMatch.amount), Decimal("0.00"))).where(
        ExpenseBankMatch.bank_transaction_id == bank_transaction_id,
        ExpenseBankMatch.status != MatchStatus.REJECTED.value,
    )
    if exclude_match_id:
        query = query.where(ExpenseBankMatch.id != exclude_match_id)
    return Decimal(session.scalar(query) or 0)


def mark_expense_fields_user_edited(expense_item: ExpenseItem, fields: set[str]) -> None:
    if not fields or expense_item.source != "dingtalk":
        return
    edited_fields: set[str] = set()
    if expense_item.user_edited_fields_json:
        try:
            decoded = json.loads(expense_item.user_edited_fields_json)
            if isinstance(decoded, list):
                edited_fields = {str(field) for field in decoded}
        except ValueError:
            edited_fields = set()
    expense_item.user_edited_fields_json = json.dumps(
        sorted(edited_fields | fields),
        ensure_ascii=False,
    )


def validate_expense_bank_match_amount(
    session: Session,
    *,
    expense_item: ExpenseItem,
    bank_transaction: BankTransaction,
    amount: Decimal,
    exclude_match_id: str | None = None,
    include_candidates: bool = False,
) -> None:
    used_expense_amount = (
        active_expense_match_amount(session, expense_item.id, exclude_match_id=exclude_match_id)
        if include_candidates
        else confirmed_expense_match_amount(session, expense_item.id, exclude_match_id=exclude_match_id)
    )
    used_bank_amount = (
        active_bank_match_amount(session, bank_transaction.id, exclude_match_id=exclude_match_id)
        if include_candidates
        else confirmed_bank_match_amount(session, bank_transaction.id, exclude_match_id=exclude_match_id)
    )
    remaining_expense_amount = Decimal(expense_item.amount) - used_expense_amount
    remaining_bank_amount = Decimal(bank_transaction.amount) - used_bank_amount
    if amount > remaining_expense_amount:
        raise HTTPException(status_code=409, detail="Match amount exceeds remaining expense amount")
    if amount > remaining_bank_amount:
        raise HTTPException(status_code=409, detail="Match amount exceeds remaining bank amount")


def parse_raw_payload(raw_payload: str | None) -> dict:
    if not raw_payload:
        return {}
    try:
        parsed = json.loads(raw_payload)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def form_values(payload: dict) -> dict[str, object | None]:
    values: dict[str, object | None] = {}
    components = payload.get("form_component_values") or payload.get("formComponentValues") or []
    if not isinstance(components, list):
        return values
    for component in components:
        if not isinstance(component, dict):
            continue
        value = component.get("value", component.get("ext_value", component.get("extValue")))
        for key_name in ("id", "name", "label"):
            key = component.get(key_name)
            if key:
                values[str(key)] = value
    return values


def table_value(payload: dict, table_key: str, cell_key: str) -> object | None:
    components = payload.get("form_component_values") or payload.get("formComponentValues") or []
    if not isinstance(components, list):
        return None
    table = next(
        (
            component
            for component in components
            if isinstance(component, dict)
            and any(str(component.get(key)) == table_key for key in ("id", "name", "label", "key") if component.get(key))
        ),
        None,
    )
    if not isinstance(table, dict):
        return None
    rows = table.get("value")
    if isinstance(rows, str):
        try:
            rows = json.loads(rows)
        except json.JSONDecodeError:
            return None
    if not isinstance(rows, list):
        return None
    values: list[object] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        cells = row.get("rowValue") or row.get("row_value") or []
        if not isinstance(cells, list):
            continue
        for cell in cells:
            if not isinstance(cell, dict):
                continue
            if any(str(cell.get(key)) == cell_key for key in ("key", "id", "name", "label", "title") if cell.get(key)):
                value = cell.get("value", cell.get("ext_value", cell.get("extValue")))
                if value not in (None, ""):
                    values.append(value)
    if not values:
        return None
    return values[0] if len(values) == 1 else values


def field_value(payload: dict, field_key: str) -> object | None:
    components = payload.get("form_component_values") or payload.get("formComponentValues") or []
    if not isinstance(components, list):
        return None
    for component in components:
        if not isinstance(component, dict):
            continue
        if any(str(component.get(key)) == field_key for key in ("id", "name", "label", "key") if component.get(key)):
            return component.get("value", component.get("ext_value", component.get("extValue")))
    return None


def mapped_display_value(payload: dict, mapping: TemplateFieldMapping) -> object | None:
    if mapping.source_path and mapping.source_path.startswith("root:"):
        return payload.get(mapping.source_path.removeprefix("root:"))
    if mapping.source_path and mapping.source_path.startswith("field:"):
        return field_value(payload, mapping.source_path.removeprefix("field:"))
    if mapping.source_path and mapping.source_path.startswith("table:"):
        _, table_key, cell_key = mapping.source_path.split(":", 2)
        return table_value(payload, table_key, cell_key)
    values = form_values(payload)
    if mapping.source_field_id and mapping.source_field_id in values:
        return values[mapping.source_field_id]
    return values.get(mapping.source_field_name)


def candidate_score(
    bank_transaction: BankTransaction | None,
    expense: ExpenseItem,
    remaining_expense_amount: Decimal,
) -> tuple[Decimal, str]:
    score = Decimal("0.00")
    reasons: list[str] = []
    if bank_transaction is None:
        if expense.store_id:
            score += Decimal("10.00")
            reasons.append("门店候选")
        if expense.expense_date:
            score += Decimal("5.00")
            reasons.append("可按日期核对")
        if not reasons:
            reasons.append("可人工核对")
        return min(score, Decimal("100.00")), "、".join(reasons)

    remaining_bank_amount = Decimal(bank_transaction.amount) - Decimal(bank_transaction.matched_amount or 0)
    if remaining_expense_amount == remaining_bank_amount:
        score += Decimal("60.00")
        reasons.append("金额完全一致")
    elif remaining_expense_amount and abs(remaining_expense_amount - remaining_bank_amount) <= Decimal("1.00"):
        score += Decimal("35.00")
        reasons.append("金额接近")

    if expense.expense_date:
        days = abs((bank_transaction.occurred_at.date() - expense.expense_date).days)
        if days <= 1:
            score += Decimal("20.00")
            reasons.append("日期接近")
        elif days <= 7:
            score += Decimal("10.00")
            reasons.append("日期在 7 天内")

    if bank_transaction.store_id and bank_transaction.store_id == expense.store_id:
        score += Decimal("10.00")
        reasons.append("门店一致")
    elif not bank_transaction.store_id:
        score += Decimal("5.00")
        reasons.append("流水待归属")

    summary = (bank_transaction.summary or "").lower()
    text_parts = [expense.description, expense.supplier_name or "", expense.payee_account or ""]
    if summary and any(part and str(part).lower() in summary for part in text_parts):
        score += Decimal("10.00")
        reasons.append("备注命中")

    if not reasons:
        reasons.append("可人工核对")
    return min(score, Decimal("100.00")), "、".join(reasons)


def display_fields_for_instance(
    mappings_by_template: dict[str, list[TemplateFieldMapping]],
    approval_instance: ApprovalInstance | None,
) -> dict[str, object | None]:
    if approval_instance is None:
        return {}
    payload = parse_raw_payload(approval_instance.raw_payload)
    fields: dict[str, object | None] = {}
    for mapping in mappings_by_template.get(approval_instance.template_id, []):
        label = mapping.display_label or mapping.source_field_name
        fields[label] = mapped_display_value(payload, mapping)
    return fields


def refresh_expense_payment_status(session: Session, expense_item: ExpenseItem) -> None:
    confirmed_amount = confirmed_expense_match_amount(session, expense_item.id)
    if confirmed_amount <= 0:
        expense_item.payment_status = ExpensePaymentStatus.UNPAID.value
    elif confirmed_amount >= Decimal(expense_item.amount):
        expense_item.payment_status = ExpensePaymentStatus.PAID.value
    else:
        expense_item.payment_status = ExpensePaymentStatus.PARTIAL_PAID.value


def refresh_bank_matched_amount(session: Session, bank_transaction: BankTransaction) -> None:
    total = session.scalar(
        select(func.coalesce(func.sum(ExpenseBankMatch.amount), Decimal("0.00"))).where(
            ExpenseBankMatch.bank_transaction_id == bank_transaction.id,
            ExpenseBankMatch.status == MatchStatus.CONFIRMED.value,
        )
    )
    bank_transaction.matched_amount = Decimal(total or 0)


def refresh_bank_assignment(session: Session, bank_transaction: BankTransaction) -> None:
    matched_expense = session.execute(
        select(ExpenseBankMatch, ExpenseItem)
        .join(ExpenseItem, ExpenseBankMatch.expense_item_id == ExpenseItem.id)
        .where(
            ExpenseBankMatch.bank_transaction_id == bank_transaction.id,
            ExpenseBankMatch.status == MatchStatus.CONFIRMED.value,
        )
        .order_by(ExpenseBankMatch.confirmed_at.desc().nullslast(), ExpenseBankMatch.created_at.desc())
        .limit(1)
    ).first()
    if matched_expense is None:
        return
    match, expense = matched_expense
    bank_transaction.store_id = expense.store_id
    bank_transaction.ledger_period = match.accounting_period or expense.ledger_period


def approval_expense_join_condition():
    return or_(
        ExpenseItem.source_document_id == ApprovalInstance.dingtalk_instance_id,
        ExpenseItem.source_document_id.like(ApprovalInstance.dingtalk_instance_id + ":%"),
    )


def approval_instance_response(
    approval: ApprovalInstance | None,
    stats: dict | None = None,
) -> ApprovalInstanceRead | None:
    if approval is None:
        return None
    current_stats = stats or approval_expense_stats([], [])
    return ApprovalInstanceRead(
        id=approval.id,
        template_id=approval.template_id,
        dingtalk_instance_id=approval.dingtalk_instance_id,
        approval_no=approval.approval_no,
        store_id=approval.store_id,
        department_name=approval.department_name,
        applicant_name=approval.applicant_name,
        applicant_user_id=approval.applicant_user_id,
        approval_status=approval.approval_status,
        parse_status=approval.parse_status,
        parse_error=approval.parse_error,
        last_parsed_at=approval.last_parsed_at,
        submit_at=approval.submit_at,
        approved_at=approval.approved_at,
        raw_payload=approval.raw_payload,
        synced_job_id=approval.synced_job_id,
        expense_item_count=current_stats["expense_item_count"],
        classified_expense_item_count=current_stats["classified_expense_item_count"],
        matched_expense_item_count=current_stats["matched_expense_item_count"],
        pending_expense_item_count=current_stats["pending_expense_item_count"],
        sync_conflict_expense_item_count=current_stats["sync_conflict_expense_item_count"],
        total_expense_amount=current_stats["total_expense_amount"],
        confirmed_match_amount=current_stats["confirmed_match_amount"],
        candidate_match_count=current_stats["candidate_match_count"],
        processing_status=current_stats["processing_status"],
        created_at=approval.created_at,
        updated_at=approval.updated_at,
    )


def real_approval_candidate_filter():
    return (
        ExpenseItem.source == "dingtalk",
        ApprovalInstance.id.is_not(None),
        ApprovalTemplate.is_enabled.is_(True),
        ~ApprovalInstance.dingtalk_instance_id.ilike("sample-%"),
        ~ApprovalInstance.dingtalk_instance_id.ilike("seed-instance-%"),
        or_(ApprovalInstance.approval_no.is_(None), ~ApprovalInstance.approval_no.ilike("SAMPLE-%")),
        or_(ApprovalInstance.approval_no.is_(None), ~ApprovalInstance.approval_no.ilike("SEED-%")),
    )


def matched_approval_keys(
    session: Session,
    *,
    store_id: str | None,
    ledger_period: str | None,
    exclude_match_id: str | None = None,
) -> tuple[set[str], set[str]]:
    """Return approval and DingTalk document IDs that already have an active match."""
    query = (
        select(ExpenseItem)
        .join(ExpenseBankMatch, ExpenseBankMatch.expense_item_id == ExpenseItem.id)
        .where(ExpenseBankMatch.status != MatchStatus.REJECTED.value)
    )
    if exclude_match_id:
        query = query.where(ExpenseBankMatch.id != exclude_match_id)
    if store_id:
        query = query.where(ExpenseItem.store_id == store_id)
    if ledger_period:
        query = query.where(ExpenseItem.ledger_period == ledger_period)

    matched_items = list(session.scalars(query))
    approval_ids = {
        item.approval_instance_id
        for item in matched_items
        if item.approval_instance_id
    }
    document_ids = {
        item.source_document_id.split(":", 1)[0]
        for item in matched_items
        if item.source == "dingtalk" and item.source_document_id
    }
    return approval_ids, document_ids


@router.get("", response_model=ApiEnvelope[Page[MatchRead]])
def list_matches(
    status: str | None = None,
    page: int = 1,
    page_size: int = 50,
    session: Session = Depends(get_session),
) -> ApiEnvelope[Page[MatchRead]]:
    query = select(ExpenseBankMatch).order_by(ExpenseBankMatch.created_at.desc())
    if status:
        query = query.where(ExpenseBankMatch.status == status)
    items, total = paginate(session, query, page, page_size)
    return ApiEnvelope(data=Page(items=items, total=total, page=page, page_size=page_size))


@router.get("/revenue", response_model=ApiEnvelope[Page[RevenueMatchRead]])
def list_revenue_matches(
    status: str | None = None,
    store_id: str | None = None,
    ledger_period: str | None = None,
    page: int = 1,
    page_size: int = 50,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[Page[RevenueMatchRead]]:
    ensure_permission(session, current_user, "reconciliation.view")
    query = (
        select(RevenueBankMatch)
        .join(BankTransaction, RevenueBankMatch.bank_transaction_id == BankTransaction.id)
        .order_by(RevenueBankMatch.created_at.desc())
    )
    if status:
        query = query.where(RevenueBankMatch.status == status)
    if store_id:
        ensure_store_access(session, current_user, store_id)
        query = query.where(BankTransaction.store_id == store_id)
    else:
        query = query.where(scoped_store_condition(session, current_user, BankTransaction.store_id))
    if ledger_period:
        query = query.where(
            or_(
                RevenueBankMatch.accounting_period == ledger_period,
                RevenueBankMatch.accounting_period.is_(None)
                & (BankTransaction.ledger_period == ledger_period),
            )
        )
    items, total = paginate(session, query, page, page_size)
    record_ids_by_match = revenue_match_record_ids_map(session, [item.id for item in items])
    return ApiEnvelope(
        data=Page(
            items=[
                revenue_match_response(session, item, record_ids_by_match.get(item.id, []))
                for item in items
            ],
            total=total,
            page=page,
            page_size=page_size,
        )
    )


def revenue_match_record_ids_map(
    session: Session,
    match_ids: list[str],
) -> dict[str, list[str]]:
    if not match_ids:
        return {}
    rows = session.execute(
        select(
            RevenueBankMatchRecord.revenue_bank_match_id,
            RevenueBankMatchRecord.revenue_record_id,
        )
        .where(RevenueBankMatchRecord.revenue_bank_match_id.in_(match_ids))
        .order_by(RevenueBankMatchRecord.created_at.asc())
    ).all()
    result: dict[str, list[str]] = {}
    for match_id, record_id in rows:
        result.setdefault(match_id, []).append(record_id)
    return result


def revenue_match_response(
    session: Session,
    match: RevenueBankMatch,
    record_ids: list[str] | None = None,
) -> RevenueMatchRead:
    response = RevenueMatchRead.model_validate(match)
    return response.model_copy(
        update={
            "revenue_record_ids": record_ids
            if record_ids is not None
            else revenue_match_record_ids_map(session, [match.id]).get(match.id, []),
        }
    )


def revenue_records_for_match(
    session: Session,
    bank_transaction: BankTransaction,
    payload: RevenueMatchCreate,
) -> list[RevenueRecord]:
    if not bank_transaction.store_id or not bank_transaction.ledger_period:
        raise HTTPException(status_code=409, detail="Bank transaction has no store assignment")
    accounting_period = payload.accounting_period or bank_transaction.ledger_period
    if payload.revenue_start_date > payload.revenue_end_date:
        raise HTTPException(status_code=422, detail="Revenue start date cannot be after end date")
    if not payload.revenue_record_ids:
        return list(
            session.scalars(
                select(RevenueRecord).where(
                    RevenueRecord.store_id == bank_transaction.store_id,
                    RevenueRecord.ledger_period == accounting_period,
                    RevenueRecord.channel == payload.channel,
                    RevenueRecord.revenue_date >= payload.revenue_start_date,
                    RevenueRecord.revenue_date <= payload.revenue_end_date,
                )
            )
        )
    if len(payload.revenue_record_ids) != len(set(payload.revenue_record_ids)):
        raise HTTPException(status_code=422, detail="Revenue record IDs must be unique")
    records = list(
        session.scalars(
            select(RevenueRecord).where(RevenueRecord.id.in_(payload.revenue_record_ids))
        )
    )
    records_by_id = {record.id: record for record in records}
    if len(records_by_id) != len(payload.revenue_record_ids):
        raise HTTPException(status_code=404, detail="Revenue record not found")
    invalid_record = next(
        (
            record
            for record in records
            if record.store_id != bank_transaction.store_id
            or record.ledger_period != accounting_period
            or record.channel != payload.channel
        ),
        None,
    )
    if invalid_record is not None:
        raise HTTPException(status_code=409, detail="Revenue record does not belong to selected bank transaction")
    return [records_by_id[record_id] for record_id in payload.revenue_record_ids]


def overlapping_revenue_match(
    session: Session,
    bank_transaction: BankTransaction,
    payload: RevenueMatchCreate,
) -> RevenueBankMatch | None:
    accounting_period = payload.accounting_period or bank_transaction.ledger_period
    common_filters = (
        BankTransaction.store_id == bank_transaction.store_id,
        or_(
            RevenueBankMatch.accounting_period == accounting_period,
            RevenueBankMatch.accounting_period.is_(None)
            & (BankTransaction.ledger_period == accounting_period),
        ),
        RevenueBankMatch.channel == payload.channel,
        RevenueBankMatch.status != MatchStatus.REJECTED.value,
    )
    legacy_overlap = session.scalar(
        select(RevenueBankMatch)
        .join(BankTransaction, RevenueBankMatch.bank_transaction_id == BankTransaction.id)
        .where(
            *common_filters,
            RevenueBankMatch.revenue_start_date <= payload.revenue_end_date,
            RevenueBankMatch.revenue_end_date >= payload.revenue_start_date,
            ~select(RevenueBankMatchRecord.id)
            .where(RevenueBankMatchRecord.revenue_bank_match_id == RevenueBankMatch.id)
            .exists(),
        )
        .limit(1)
    )
    if legacy_overlap is not None:
        return legacy_overlap

    exact_query = (
        select(RevenueBankMatch)
        .join(BankTransaction, RevenueBankMatch.bank_transaction_id == BankTransaction.id)
        .join(
            RevenueBankMatchRecord,
            RevenueBankMatchRecord.revenue_bank_match_id == RevenueBankMatch.id,
        )
        .join(RevenueRecord, RevenueBankMatchRecord.revenue_record_id == RevenueRecord.id)
        .where(
            *common_filters,
            RevenueRecord.revenue_date >= payload.revenue_start_date,
            RevenueRecord.revenue_date <= payload.revenue_end_date,
        )
    )
    if payload.revenue_record_ids:
        exact_query = exact_query.where(
            RevenueBankMatchRecord.revenue_record_id.in_(payload.revenue_record_ids)
        )
    return session.scalar(exact_query.limit(1))


def revenue_range_total(session: Session, bank_transaction: BankTransaction, payload: RevenueMatchCreate) -> Decimal:
    if not bank_transaction.store_id or not bank_transaction.ledger_period:
        raise HTTPException(status_code=409, detail="Bank transaction has no store assignment")
    if payload.revenue_start_date > payload.revenue_end_date:
        raise HTTPException(status_code=422, detail="Revenue start date cannot be after end date")
    records = revenue_records_for_match(session, bank_transaction, payload)
    return sum((Decimal(record.net_amount) for record in records), Decimal("0.00"))


@router.post("/revenue", response_model=ApiEnvelope[RevenueMatchRead], status_code=201)
def create_revenue_match_candidate(
    payload: RevenueMatchCreate,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[RevenueMatchRead]:
    ensure_permission(session, current_user, "reconciliation.manage")
    bank_transaction = session.get(BankTransaction, payload.bank_transaction_id)
    if bank_transaction is None:
        raise HTTPException(status_code=404, detail="Bank transaction not found")
    ensure_store_access(session, current_user, bank_transaction.store_id)
    if bank_transaction.direction != "income":
        raise HTTPException(status_code=409, detail="Bank transaction is not income")
    channel = session.scalar(select(RevenueChannel).where(RevenueChannel.name == payload.channel))
    if channel is None:
        raise HTTPException(status_code=404, detail="Revenue channel not found")
    if channel.status != MasterDataStatus.ACTIVE.value:
        raise HTTPException(status_code=409, detail="Revenue channel is inactive")

    records = revenue_records_for_match(session, bank_transaction, payload)
    total = sum((Decimal(record.net_amount) for record in records), Decimal("0.00"))
    if total <= 0:
        raise HTTPException(status_code=409, detail="Revenue records not found for selected range")
    if payload.amount != total:
        raise HTTPException(status_code=409, detail="Match amount must equal selected revenue net amount")
    remaining_bank_amount = Decimal(bank_transaction.amount) - Decimal(bank_transaction.matched_amount or 0)
    if payload.amount > remaining_bank_amount:
        raise HTTPException(status_code=409, detail="Match amount exceeds remaining bank amount")
    overlapping_match = overlapping_revenue_match(session, bank_transaction, payload)
    if overlapping_match is not None:
        raise HTTPException(status_code=409, detail="Revenue records already matched for selected range")

    match = RevenueBankMatch(
        **payload.model_dump(exclude={"revenue_record_ids"}),
        status=MatchStatus.CANDIDATE.value,
    )
    session.add(match)
    try:
        session.flush()
        if payload.revenue_record_ids:
            session.add_all(
                [
                    RevenueBankMatchRecord(
                        revenue_bank_match_id=match.id,
                        revenue_record_id=record.id,
                    )
                    for record in records
                ]
            )
            session.flush()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(status_code=409, detail="Revenue bank match already exists") from exc
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="revenue_match.create",
        resource_type="revenue_bank_match",
        resource_id=match.id,
        summary="创建收入流水匹配候选",
        metadata={
            "bank_transaction_id": match.bank_transaction_id,
            "channel": match.channel,
            "revenue_start_date": match.revenue_start_date,
            "revenue_end_date": match.revenue_end_date,
            "amount": match.amount,
        },
    )
    session.commit()
    session.refresh(match)
    return ApiEnvelope(data=revenue_match_response(session, match, payload.revenue_record_ids))


@router.post("/revenue/batch", response_model=ApiEnvelope[list[RevenueMatchRead]], status_code=201)
def create_revenue_match_batch(
    payload: RevenueMatchBatchCreate,
    operator: str = "admin",
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[list[RevenueMatchRead]]:
    """Confirm one bank transaction against revenue records from one or more channels.

    RevenueBankMatch keeps a single channel for reporting, so a cross-channel selection is
    persisted as one confirmed match per channel inside the same database transaction.
    """
    ensure_permission(session, current_user, "reconciliation.manage")
    bank_transaction = session.scalar(
        select(BankTransaction)
        .where(BankTransaction.id == payload.bank_transaction_id)
        .with_for_update()
    )
    if bank_transaction is None:
        raise HTTPException(status_code=404, detail="Bank transaction not found")
    ensure_store_access(session, current_user, bank_transaction.store_id)
    if bank_transaction.direction != "income":
        raise HTTPException(status_code=409, detail="Bank transaction is not income")
    if len(payload.revenue_record_ids) != len(set(payload.revenue_record_ids)):
        raise HTTPException(status_code=422, detail="Revenue record IDs must be unique")

    records = list(
        session.scalars(
            select(RevenueRecord).where(RevenueRecord.id.in_(payload.revenue_record_ids))
        )
    )
    records_by_id = {record.id: record for record in records}
    if len(records_by_id) != len(payload.revenue_record_ids):
        raise HTTPException(status_code=404, detail="Revenue record not found")
    invalid_record = next(
        (
            record
            for record in records
            if record.store_id != bank_transaction.store_id
            or record.ledger_period != (payload.accounting_period or bank_transaction.ledger_period)
        ),
        None,
    )
    if invalid_record is not None:
        raise HTTPException(status_code=409, detail="Revenue record does not belong to selected bank transaction")

    channel_names = {record.channel for record in records}
    channels = {
        channel.name: channel
        for channel in session.scalars(
            select(RevenueChannel).where(RevenueChannel.name.in_(channel_names))
        )
    }
    inactive_or_missing_channel = next(
        (
            channel_name
            for channel_name in channel_names
            if channel_name not in channels
            or channels[channel_name].status != MasterDataStatus.ACTIVE.value
        ),
        None,
    )
    if inactive_or_missing_channel is not None:
        raise HTTPException(status_code=409, detail="Revenue channel is missing or inactive")

    total = sum((Decimal(record.net_amount) for record in records), Decimal("0.00"))
    if total <= 0:
        raise HTTPException(status_code=409, detail="Revenue records not found for selected range")
    if payload.amount != total:
        raise HTTPException(status_code=409, detail="Match amount must equal selected revenue net amount")
    remaining_bank_amount = Decimal(bank_transaction.amount) - Decimal(bank_transaction.matched_amount or 0)
    if payload.amount > remaining_bank_amount:
        raise HTTPException(status_code=409, detail="Match amount exceeds remaining bank amount")

    existing_record_match = session.scalar(
        select(RevenueBankMatchRecord)
        .join(RevenueBankMatch, RevenueBankMatchRecord.revenue_bank_match_id == RevenueBankMatch.id)
        .where(
            RevenueBankMatchRecord.revenue_record_id.in_(payload.revenue_record_ids),
            RevenueBankMatch.status != MatchStatus.REJECTED.value,
        )
        .limit(1)
    )
    if existing_record_match is not None:
        raise HTTPException(status_code=409, detail="Revenue records already matched")

    records_by_channel: dict[str, list[RevenueRecord]] = {}
    for record_id in payload.revenue_record_ids:
        record = records_by_id[record_id]
        records_by_channel.setdefault(record.channel, []).append(record)

    match_specs: list[tuple[str, list[RevenueRecord], Decimal, date, date]] = []
    for channel, channel_records in records_by_channel.items():
        start_date = min(record.revenue_date for record in channel_records)
        end_date = max(record.revenue_date for record in channel_records)
        channel_amount = sum(
            (Decimal(record.net_amount) for record in channel_records),
            Decimal("0.00"),
        )
        channel_payload = RevenueMatchCreate(
            bank_transaction_id=bank_transaction.id,
            channel=channel,
            revenue_start_date=start_date,
            revenue_end_date=end_date,
            amount=channel_amount,
            accounting_period=payload.accounting_period or bank_transaction.ledger_period,
            revenue_record_ids=[record.id for record in channel_records],
            confidence=payload.confidence,
            reason=payload.reason,
        )
        if overlapping_revenue_match(session, bank_transaction, channel_payload) is not None:
            raise HTTPException(status_code=409, detail="Revenue records already matched for selected range")
        match_specs.append((channel, channel_records, channel_amount, start_date, end_date))

    matches: list[RevenueBankMatch] = []
    for channel, channel_records, channel_amount, start_date, end_date in match_specs:
        match = RevenueBankMatch(
            bank_transaction_id=bank_transaction.id,
            channel=channel,
            revenue_start_date=start_date,
            revenue_end_date=end_date,
            amount=channel_amount,
            accounting_period=payload.accounting_period or bank_transaction.ledger_period,
            status=MatchStatus.CONFIRMED.value,
            confidence=payload.confidence,
            reason=payload.reason,
            confirmed_by=operator,
            confirmed_at=utc_now(),
        )
        session.add(match)
        matches.append(match)

    try:
        session.flush()
        for match, (_, channel_records, _, _, _) in zip(matches, match_specs, strict=True):
            session.add_all(
                [
                    RevenueBankMatchRecord(
                        revenue_bank_match_id=match.id,
                        revenue_record_id=record.id,
                    )
                    for record in channel_records
                ]
            )
        session.flush()
        bank_transaction.matched_amount = Decimal(bank_transaction.matched_amount or 0) + total
        for match in matches:
            write_audit_log(
                session,
                actor=audit_actor(current_user, operator),
                action="revenue_match.create",
                resource_type="revenue_bank_match",
                resource_id=match.id,
                summary="创建收入流水匹配",
                metadata={
                    "bank_transaction_id": match.bank_transaction_id,
                    "channel": match.channel,
                    "amount": match.amount,
                },
            )
            write_audit_log(
                session,
                actor=audit_actor(current_user, operator),
                action="revenue_match.confirm",
                resource_type="revenue_bank_match",
                resource_id=match.id,
                summary="确认收入流水匹配",
                metadata={
                    "bank_transaction_id": match.bank_transaction_id,
                    "channel": match.channel,
                    "amount": match.amount,
                },
            )
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(status_code=409, detail="Revenue bank match already exists") from exc

    for match in matches:
        session.refresh(match)
    record_ids_by_match = revenue_match_record_ids_map(session, [match.id for match in matches])
    return ApiEnvelope(
        data=[
            revenue_match_response(session, match, record_ids_by_match.get(match.id, []))
            for match in matches
        ]
    )


@router.post("/revenue/{match_id}/confirm", response_model=ApiEnvelope[RevenueMatchRead])
def confirm_revenue_match(
    match_id: str,
    operator: str = "system",
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[RevenueMatchRead]:
    ensure_permission(session, current_user, "reconciliation.manage")
    match = session.get(RevenueBankMatch, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Revenue match not found")
    bank_transaction = session.get(BankTransaction, match.bank_transaction_id)
    if bank_transaction is None:
        raise HTTPException(status_code=409, detail="Matched bank transaction is missing")
    ensure_store_access(session, current_user, bank_transaction.store_id)
    if match.status == MatchStatus.CONFIRMED.value:
        return ApiEnvelope(data=match)
    if match.status == MatchStatus.REJECTED.value:
        raise HTTPException(status_code=409, detail="Rejected match cannot be confirmed")

    remaining_bank_amount = Decimal(bank_transaction.amount) - Decimal(bank_transaction.matched_amount or 0)
    if match.amount > remaining_bank_amount:
        raise HTTPException(status_code=409, detail="Match amount exceeds remaining bank amount")

    match.status = MatchStatus.CONFIRMED.value
    match.confirmed_by = operator
    match.confirmed_at = utc_now()
    bank_transaction.matched_amount = Decimal(bank_transaction.matched_amount or 0) + match.amount
    write_audit_log(
        session,
        actor=audit_actor(current_user, operator),
        action="revenue_match.confirm",
        resource_type="revenue_bank_match",
        resource_id=match.id,
        summary="确认收入流水匹配",
        metadata={
            "bank_transaction_id": match.bank_transaction_id,
            "channel": match.channel,
            "amount": match.amount,
        },
    )
    session.commit()
    session.refresh(match)
    return ApiEnvelope(data=revenue_match_response(session, match))


@router.post("/revenue/{match_id}/reject", response_model=ApiEnvelope[RevenueMatchRead])
def reject_revenue_match(
    match_id: str,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[RevenueMatchRead]:
    ensure_permission(session, current_user, "reconciliation.manage")
    match = session.get(RevenueBankMatch, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Revenue match not found")
    bank_transaction = session.get(BankTransaction, match.bank_transaction_id)
    if bank_transaction is None:
        raise HTTPException(status_code=409, detail="Matched bank transaction is missing")
    ensure_store_access(session, current_user, bank_transaction.store_id)
    if match.status == MatchStatus.CONFIRMED.value:
        raise HTTPException(status_code=409, detail="Confirmed match cannot be rejected")
    match.status = MatchStatus.REJECTED.value
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="revenue_match.reject",
        resource_type="revenue_bank_match",
        resource_id=match.id,
        summary="驳回收入流水匹配候选",
    )
    session.commit()
    session.refresh(match)
    return ApiEnvelope(data=revenue_match_response(session, match))


@router.post("/revenue/{match_id}/unmatch", response_model=ApiEnvelope[RevenueMatchRead])
def unmatch_revenue_match(
    match_id: str,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[RevenueMatchRead]:
    ensure_permission(session, current_user, "reconciliation.manage")
    match = session.get(RevenueBankMatch, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Revenue match not found")
    bank_transaction = session.get(BankTransaction, match.bank_transaction_id)
    if bank_transaction is None:
        raise HTTPException(status_code=409, detail="Matched bank transaction is missing")
    ensure_store_access(session, current_user, bank_transaction.store_id)
    if match.status != MatchStatus.CONFIRMED.value:
        raise HTTPException(status_code=409, detail="Only confirmed match can be unmatched")

    bank_transaction.matched_amount = max(
        Decimal("0.00"),
        Decimal(bank_transaction.matched_amount or 0) - Decimal(match.amount or 0),
    )
    match.status = MatchStatus.REJECTED.value
    match.confirmed_by = None
    match.confirmed_at = None
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="revenue_match.unmatch",
        resource_type="revenue_bank_match",
        resource_id=match.id,
        summary="解除收入流水匹配",
        metadata={
            "bank_transaction_id": match.bank_transaction_id,
            "channel": match.channel,
            "amount": match.amount,
        },
    )
    session.commit()
    session.refresh(match)
    return ApiEnvelope(data=revenue_match_response(session, match))


@router.post("", response_model=ApiEnvelope[MatchRead], status_code=201)
def create_match_candidate(
    payload: MatchCreate,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[MatchRead]:
    ensure_permission(session, current_user, "reconciliation.manage")
    expense_item = session.get(ExpenseItem, payload.expense_item_id)
    if expense_item is None:
        raise HTTPException(status_code=404, detail="Expense item not found")
    ensure_store_access(session, current_user, expense_item.store_id)
    bank_transaction = session.get(BankTransaction, payload.bank_transaction_id)
    if bank_transaction is None:
        raise HTTPException(status_code=404, detail="Bank transaction not found")
    ensure_store_access(session, current_user, bank_transaction.store_id)
    if bank_transaction.direction != "expense":
        raise HTTPException(status_code=409, detail="Bank transaction is not expense")
    if bank_transaction.store_id and expense_item.store_id != bank_transaction.store_id:
        raise HTTPException(status_code=409, detail="Store mismatch")
    if bank_transaction.ledger_period and expense_item.ledger_period != bank_transaction.ledger_period:
        raise HTTPException(status_code=409, detail="Ledger period mismatch")

    existing_match = session.scalar(
        select(ExpenseBankMatch).where(
            ExpenseBankMatch.expense_item_id == payload.expense_item_id,
            ExpenseBankMatch.bank_transaction_id == payload.bank_transaction_id,
        )
    )
    if existing_match is not None:
        if existing_match.status == MatchStatus.CONFIRMED.value:
            raise HTTPException(status_code=409, detail="This bank transaction is already matched to the approval")
        validate_expense_bank_match_amount(
            session,
            expense_item=expense_item,
            bank_transaction=bank_transaction,
            amount=payload.amount,
            exclude_match_id=existing_match.id,
            include_candidates=True,
        )
        if payload.category_l1 is not None:
            expense_item.category_l1 = payload.category_l1
        if payload.category_l2 is not None:
            expense_item.category_l2 = payload.category_l2
        mark_expense_fields_user_edited(
            expense_item,
            {
                field
                for field, value in {
                    "category_l1": payload.category_l1,
                    "category_l2": payload.category_l2,
                }.items()
                if value is not None
            },
        )
        for key, value in payload.model_dump(exclude={"category_l1", "category_l2"}).items():
            setattr(existing_match, key, value)
        existing_match.status = MatchStatus.CANDIDATE.value
        existing_match.confirmed_by = None
        existing_match.confirmed_at = None
        refresh_approval_processing_status(session, expense_item.approval_instance_id)
        session.commit()
        session.refresh(existing_match)
        return ApiEnvelope(data=existing_match)

    if payload.accounting_period and bank_transaction.ledger_period and payload.accounting_period != bank_transaction.ledger_period:
        raise HTTPException(status_code=409, detail="Accounting period does not match bank transaction period")
    validate_expense_bank_match_amount(
        session,
        expense_item=expense_item,
        bank_transaction=bank_transaction,
        amount=payload.amount,
        include_candidates=True,
    )
    payload_data = payload.model_dump(exclude={"category_l1", "category_l2"})
    if payload.category_l1 is not None:
        expense_item.category_l1 = payload.category_l1
    if payload.category_l2 is not None:
        expense_item.category_l2 = payload.category_l2
    mark_expense_fields_user_edited(
        expense_item,
        {
            field
            for field, value in {
                "category_l1": payload.category_l1,
                "category_l2": payload.category_l2,
            }.items()
            if value is not None
        },
    )
    match = ExpenseBankMatch(**payload_data, status=MatchStatus.CANDIDATE.value)
    session.add(match)
    session.flush()
    refresh_approval_processing_status(session, expense_item.approval_instance_id)
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="match.create",
        resource_type="expense_bank_match",
        resource_id=match.id,
        summary="创建流水匹配候选",
        metadata={
            "expense_item_id": match.expense_item_id,
            "bank_transaction_id": match.bank_transaction_id,
            "amount": match.amount,
        },
    )
    session.commit()
    session.refresh(match)
    return ApiEnvelope(data=match)


@router.post("/auto-suggest", response_model=ApiEnvelope[AutoMatchResult], status_code=201)
def auto_suggest_matches(
    store_id: str | None = None,
    ledger_period: str | None = None,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[AutoMatchResult]:
    ensure_permission(session, current_user, "reconciliation.manage")
    expense_query = select(ExpenseItem).where(
        ExpenseItem.payment_status.in_(
            [ExpensePaymentStatus.UNPAID.value, ExpensePaymentStatus.PARTIAL_PAID.value]
        )
    )
    bank_query = select(BankTransaction).where(BankTransaction.direction == "expense")
    if store_id:
        ensure_store_access(session, current_user, store_id)
        expense_query = expense_query.where(ExpenseItem.store_id == store_id)
        bank_query = bank_query.where(BankTransaction.store_id == store_id)
    else:
        expense_query = expense_query.where(scoped_store_condition(session, current_user, ExpenseItem.store_id))
        bank_query = bank_query.where(scoped_store_condition(session, current_user, BankTransaction.store_id))
    if ledger_period:
        expense_query = expense_query.where(ExpenseItem.ledger_period == ledger_period)
        bank_query = bank_query.where(BankTransaction.ledger_period == ledger_period)

    expenses = list(session.scalars(expense_query.order_by(ExpenseItem.created_at.asc())))
    bank_transactions = [
        transaction
        for transaction in session.scalars(bank_query.order_by(BankTransaction.occurred_at.asc()))
        if Decimal(transaction.amount) > Decimal(transaction.matched_amount or 0)
    ]
    existing_pairs = {
        (match.expense_item_id, match.bank_transaction_id)
        for match in session.scalars(select(ExpenseBankMatch))
    }

    created_matches: list[ExpenseBankMatch] = []
    used_expense_ids: set[str] = set()
    used_bank_ids: set[str] = set()
    skipped_count = 0

    for expense in expenses:
        if expense.id in used_expense_ids:
            continue
        for transaction in bank_transactions:
            if transaction.id in used_bank_ids:
                continue
            if (expense.id, transaction.id) in existing_pairs:
                skipped_count += 1
                continue
            if expense.store_id != transaction.store_id or expense.ledger_period != transaction.ledger_period:
                continue
            remaining_expense_amount = Decimal(expense.amount) - confirmed_expense_match_amount(session, expense.id)
            remaining_bank_amount = Decimal(transaction.amount) - Decimal(transaction.matched_amount or 0)
            if remaining_expense_amount <= 0 or remaining_expense_amount != remaining_bank_amount:
                continue

            confidence = Decimal("98.00") if expense.supplier_name and expense.supplier_name == transaction.counterparty_name else Decimal("92.00")
            reason = "金额、门店和账期一致"
            if confidence == Decimal("98.00"):
                reason = "金额、门店、账期和供应商一致"
            match = ExpenseBankMatch(
                expense_item_id=expense.id,
                bank_transaction_id=transaction.id,
                amount=remaining_expense_amount,
                status=MatchStatus.CANDIDATE.value,
                confidence=confidence,
                reason=reason,
            )
            session.add(match)
            created_matches.append(match)
            existing_pairs.add((expense.id, transaction.id))
            used_expense_ids.add(expense.id)
            used_bank_ids.add(transaction.id)
            break

    if created_matches:
        session.flush()
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="match.auto_suggest",
        resource_type="expense_bank_match",
        summary=f"自动生成匹配候选：{len(created_matches)} 条",
        metadata={"store_id": store_id, "ledger_period": ledger_period, "skipped_count": skipped_count},
    )
    session.commit()
    for match in created_matches:
        session.refresh(match)
    return ApiEnvelope(
        data=AutoMatchResult(
            created_count=len(created_matches),
            skipped_count=skipped_count,
            matches=created_matches,
        )
    )


@router.get(
    "/reconciliation/candidates",
    response_model=ApiEnvelope[ReconciliationCandidateResult],
)
def list_reconciliation_candidates(
    bank_transaction_id: str | None = Query(default=None),
    template_id: str | None = Query(default=None),
    store_id: str | None = Query(default=None),
    ledger_period: str | None = Query(default=None),
    approval_no: str | None = Query(default=None),
    exclude_match_id: str | None = Query(default=None),
    approval_only: bool = Query(default=False),
    page_size: int = Query(default=50, ge=1, le=100),
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[ReconciliationCandidateResult]:
    ensure_permission(session, current_user, "reconciliation.view")
    approval_search = approval_no.strip() if approval_no and approval_no.strip() else None
    bank_transaction = session.get(BankTransaction, bank_transaction_id) if bank_transaction_id else None
    if bank_transaction_id and bank_transaction is None:
        raise HTTPException(status_code=404, detail="Bank transaction not found")
    if bank_transaction is not None:
        ensure_store_access(session, current_user, bank_transaction.store_id)
    ensure_store_access(session, current_user, store_id)
    if bank_transaction is not None and bank_transaction.direction != "expense":
        raise HTTPException(status_code=409, detail="Only expense bank transactions can match approvals")

    excluded_match = session.get(ExpenseBankMatch, exclude_match_id) if exclude_match_id else None
    if excluded_match and bank_transaction is None:
        raise HTTPException(status_code=409, detail="Exclude match requires bank transaction")
    if excluded_match and bank_transaction is not None and excluded_match.bank_transaction_id != bank_transaction.id:
        raise HTTPException(status_code=409, detail="Excluded match belongs to another bank transaction")
    remaining_bank_amount = Decimal("0.00")
    if bank_transaction is not None:
        remaining_bank_amount = Decimal(bank_transaction.amount) - active_bank_match_amount(
            session,
            bank_transaction.id,
            exclude_match_id=exclude_match_id,
        )
        if remaining_bank_amount <= 0:
            return ApiEnvelope(
                data=ReconciliationCandidateResult(
                    bank_transaction=bank_transaction,
                    remaining_amount=Decimal("0.00"),
                    candidates=[],
                )
            )

    query = (
        select(ExpenseItem, ApprovalInstance, ApprovalTemplate)
        .outerjoin(ApprovalInstance, approval_expense_join_condition())
        .outerjoin(ApprovalTemplate, ApprovalInstance.template_id == ApprovalTemplate.id)
        .where(
            or_(
                ExpenseItem.source != "dingtalk",
                ApprovalTemplate.is_enabled.is_(True),
            )
        )
    )
    if not approval_search:
        query = query.where(
            ExpenseItem.payment_status.in_(
                [ExpensePaymentStatus.UNPAID.value, ExpensePaymentStatus.PARTIAL_PAID.value]
            )
        )
    if template_id:
        query = query.where(ApprovalInstance.template_id == template_id)
    if approval_only:
        query = query.where(*real_approval_candidate_filter())
    if store_id:
        query = query.where(ExpenseItem.store_id == store_id)
    else:
        query = query.where(scoped_store_condition(session, current_user, ExpenseItem.store_id))
    if ledger_period:
        query = query.where(ExpenseItem.ledger_period == ledger_period)
    if approval_search:
        like = f"%{approval_search}%"
        query = query.where(
            (ApprovalInstance.approval_no.ilike(like))
            | (ApprovalInstance.dingtalk_instance_id.ilike(like))
            | (ExpenseItem.source_document_id.ilike(like))
        )

    rows = session.execute(query.order_by(ExpenseItem.expense_date.desc(), ExpenseItem.created_at.desc())).all()
    line_document_ids = {
        expense.source_document_id.split(":", 1)[0]
        for expense, _approval, _template in rows
        if expense.source == "dingtalk" and expense.source_document_id and ":" in expense.source_document_id
    }
    template_ids = {approval.template_id for _, approval, _ in rows if approval is not None}
    mappings_by_template: dict[str, list[TemplateFieldMapping]] = {
        current_template_id: list(
            session.scalars(
                select(TemplateFieldMapping)
                .where(
                    TemplateFieldMapping.template_id == current_template_id,
                    TemplateFieldMapping.show_in_list.is_(True),
                )
                .order_by(TemplateFieldMapping.sort_order.asc(), TemplateFieldMapping.created_at.asc())
            )
        )
        for current_template_id in template_ids
    }
    approval_stats = approval_expense_stats_map(
        session,
        list({approval.id for _, approval, _ in rows if approval is not None}),
    )

    candidates: list[ReconciliationExpenseCandidate] = []
    active_expense_ids = {
        match.expense_item_id
        for match in session.scalars(
            select(ExpenseBankMatch).where(
                ExpenseBankMatch.status == MatchStatus.CANDIDATE.value,
                ExpenseBankMatch.id != exclude_match_id,
            )
        )
    }
    matched_approval_ids, matched_document_ids = matched_approval_keys(
        session,
        store_id=store_id,
        ledger_period=None,
        exclude_match_id=exclude_match_id,
    )
    for expense, approval, template in rows:
        if not approval_search and approval is not None and (
            approval.id in matched_approval_ids
            or approval.dingtalk_instance_id in matched_document_ids
        ):
            continue
        if (
            expense.source == "dingtalk"
            and expense.source_document_id
            and ":" not in expense.source_document_id
            and expense.source_document_id in line_document_ids
        ):
            continue
        if expense.id in active_expense_ids:
            continue
        remaining_expense_amount = Decimal(expense.amount) - confirmed_expense_match_amount(
            session,
            expense.id,
            exclude_match_id=exclude_match_id,
        )
        if remaining_expense_amount <= 0 and not approval_search:
            continue
        score, reason = candidate_score(bank_transaction, expense, remaining_expense_amount)
        candidates.append(
            ReconciliationExpenseCandidate(
                expense_item=expense,
                approval_instance=approval_instance_response(
                    approval,
                    approval_stats.get(approval.id) if approval is not None else None,
                ),
                template_name=template.name if template else None,
                display_fields=display_fields_for_instance(mappings_by_template, approval),
                remaining_amount=remaining_expense_amount,
                score=score,
                reason=reason,
            )
        )

    candidates.sort(key=lambda item: (item.score, item.expense_item.expense_date or item.expense_item.created_at.date()), reverse=True)
    return ApiEnvelope(
        data=ReconciliationCandidateResult(
            bank_transaction=bank_transaction,
            remaining_amount=remaining_bank_amount,
            candidates=candidates[: min(page_size, 100)],
        )
    )


@router.get(
    "/reconciliation/records",
    response_model=ApiEnvelope[Page[ReconciliationRecord]],
)
def list_reconciliation_records(
    status: str = MatchStatus.CONFIRMED.value,
    accounting_period: str | None = None,
    store_id: str | None = None,
    page: int = 1,
    page_size: int = 50,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[Page[ReconciliationRecord]]:
    ensure_permission(session, current_user, "reconciliation.view")
    query = (
        select(ExpenseBankMatch, BankTransaction, ExpenseItem, ApprovalInstance, ApprovalTemplate)
        .join(BankTransaction, ExpenseBankMatch.bank_transaction_id == BankTransaction.id)
        .join(ExpenseItem, ExpenseBankMatch.expense_item_id == ExpenseItem.id)
        .outerjoin(ApprovalInstance, approval_expense_join_condition())
        .outerjoin(ApprovalTemplate, ApprovalInstance.template_id == ApprovalTemplate.id)
        .where(ExpenseBankMatch.status == status)
        .order_by(ExpenseBankMatch.confirmed_at.desc().nullslast(), ExpenseBankMatch.created_at.desc())
    )
    if accounting_period:
        query = query.where(ExpenseBankMatch.accounting_period == accounting_period)
    if store_id:
        ensure_store_access(session, current_user, store_id)
        query = query.where(ExpenseItem.store_id == store_id)
    else:
        query = query.where(scoped_store_condition(session, current_user, ExpenseItem.store_id))

    page = max(page, 1)
    page_size = min(max(page_size, 1), 200)
    total = session.scalar(select(func.count()).select_from(query.subquery())) or 0
    rows = session.execute(query.offset((page - 1) * page_size).limit(page_size)).all()
    template_ids = {approval.template_id for _, _, _, approval, _ in rows if approval is not None}
    approval_stats = approval_expense_stats_map(
        session,
        list({approval.id for _, _, _, approval, _ in rows if approval is not None}),
    )
    mappings_by_template: dict[str, list[TemplateFieldMapping]] = {
        current_template_id: list(
            session.scalars(
                select(TemplateFieldMapping)
                .where(
                    TemplateFieldMapping.template_id == current_template_id,
                    TemplateFieldMapping.show_in_list.is_(True),
                )
                .order_by(TemplateFieldMapping.sort_order.asc(), TemplateFieldMapping.created_at.asc())
            )
        )
        for current_template_id in template_ids
    }
    records = [
        ReconciliationRecord(
            match=match,
            bank_transaction=bank_transaction,
            expense_item=expense,
            approval_instance=approval_instance_response(
                approval,
                approval_stats.get(approval.id) if approval is not None else None,
            ),
            template_name=template.name if template else None,
            display_fields=display_fields_for_instance(mappings_by_template, approval),
        )
        for match, bank_transaction, expense, approval, template in rows
    ]
    return ApiEnvelope(data=Page(items=records, total=total, page=page, page_size=page_size))


@router.patch(
    "/reconciliation/records/{match_id}",
    response_model=ApiEnvelope[MatchRead],
)
def update_reconciliation_record(
    match_id: str,
    payload: ReconciliationRecordUpdate,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[MatchRead]:
    ensure_permission(session, current_user, "reconciliation.manage")
    match = session.get(ExpenseBankMatch, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Match not found")
    if match.status != MatchStatus.CONFIRMED.value:
        raise HTTPException(status_code=409, detail="Only confirmed reconciliation records can be edited")

    bank_transaction = session.get(BankTransaction, match.bank_transaction_id)
    old_expense = session.get(ExpenseItem, match.expense_item_id)
    if bank_transaction is None or old_expense is None:
        raise HTTPException(status_code=409, detail="Matched source record is missing")
    ensure_store_access(session, current_user, bank_transaction.store_id)
    ensure_store_access(session, current_user, old_expense.store_id)

    updates = payload.model_dump(exclude_unset=True)
    target_expense = old_expense
    if "expense_item_id" in updates and updates["expense_item_id"] != match.expense_item_id:
        target_expense = session.get(ExpenseItem, updates["expense_item_id"])
        if target_expense is None:
            raise HTTPException(status_code=404, detail="Expense item not found")
        ensure_store_access(session, current_user, target_expense.store_id)

    target_amount = updates.get("amount", match.amount)
    target_period = updates.get("accounting_period", match.accounting_period) or target_expense.ledger_period
    other_expense_store_ids = {
        expense.store_id
        for expense in session.scalars(
            select(ExpenseItem)
            .join(ExpenseBankMatch, ExpenseBankMatch.expense_item_id == ExpenseItem.id)
            .where(
                ExpenseBankMatch.bank_transaction_id == bank_transaction.id,
                ExpenseBankMatch.status == MatchStatus.CONFIRMED.value,
                ExpenseBankMatch.id != match.id,
            )
        )
    }
    if other_expense_store_ids and other_expense_store_ids != {target_expense.store_id}:
        raise HTTPException(status_code=409, detail="Bank transaction already matched to another store")
    validate_expense_bank_match_amount(
        session,
        expense_item=target_expense,
        bank_transaction=bank_transaction,
        amount=target_amount,
        exclude_match_id=match.id,
    )

    match.expense_item_id = target_expense.id
    match.amount = target_amount
    match.accounting_period = target_period
    if "bank_occurred" in updates:
        match.bank_occurred = updates["bank_occurred"]
    if "reason" in updates:
        match.reason = updates["reason"]
    if "category_l1" in updates:
        target_expense.category_l1 = updates["category_l1"]
    if "category_l2" in updates:
        target_expense.category_l2 = updates["category_l2"]
    mark_expense_fields_user_edited(
        target_expense,
        {field for field in ("category_l1", "category_l2") if field in updates},
    )

    bank_transaction.store_id = target_expense.store_id

    try:
        session.flush()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(status_code=409, detail="Expense bank match already exists") from exc

    refresh_bank_matched_amount(session, bank_transaction)
    refresh_expense_payment_status(session, old_expense)
    if target_expense.id != old_expense.id:
        refresh_expense_payment_status(session, target_expense)
    refresh_approval_processing_status(session, old_expense.approval_instance_id)
    if target_expense.id != old_expense.id:
        refresh_approval_processing_status(session, target_expense.approval_instance_id)

    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="match.reconciliation.update",
        resource_type="expense_bank_match",
        resource_id=match.id,
        summary="更新对账记录",
        metadata={
            "expense_item_id": match.expense_item_id,
            "bank_transaction_id": match.bank_transaction_id,
            "amount": match.amount,
            "accounting_period": match.accounting_period,
            "bank_occurred": match.bank_occurred,
        },
    )
    session.commit()
    session.refresh(match)
    return ApiEnvelope(data=match)


@router.post(
    "/reconciliation/records/{match_id}/unmatch",
    response_model=ApiEnvelope[MatchRead],
)
def unmatch_reconciliation_record(
    match_id: str,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[MatchRead]:
    ensure_permission(session, current_user, "reconciliation.manage")
    match = session.get(ExpenseBankMatch, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Match not found")
    if match.status != MatchStatus.CONFIRMED.value:
        raise HTTPException(status_code=409, detail="Only confirmed reconciliation records can be unmatched")

    bank_transaction = session.get(BankTransaction, match.bank_transaction_id)
    expense_item = session.get(ExpenseItem, match.expense_item_id)
    if bank_transaction is None or expense_item is None:
        raise HTTPException(status_code=409, detail="Matched source record is missing")
    ensure_store_access(session, current_user, bank_transaction.store_id)
    ensure_store_access(session, current_user, expense_item.store_id)

    match.status = MatchStatus.REJECTED.value
    match.reason = f"{match.reason}\n解除匹配" if match.reason else "解除匹配"

    session.flush()
    refresh_bank_matched_amount(session, bank_transaction)
    refresh_bank_assignment(session, bank_transaction)
    refresh_expense_payment_status(session, expense_item)
    refresh_approval_processing_status(session, expense_item.approval_instance_id)

    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="match.reconciliation.unmatch",
        resource_type="expense_bank_match",
        resource_id=match.id,
        summary="解除对账匹配",
        metadata={
            "expense_item_id": match.expense_item_id,
            "bank_transaction_id": match.bank_transaction_id,
            "amount": match.amount,
            "accounting_period": match.accounting_period,
        },
    )
    session.commit()
    session.refresh(match)
    return ApiEnvelope(data=match)


@router.post("/{match_id}/confirm", response_model=ApiEnvelope[MatchRead])
def confirm_match(
    match_id: str,
    operator: str = "system",
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[MatchRead]:
    ensure_permission(session, current_user, "reconciliation.manage")
    match = session.get(ExpenseBankMatch, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Match not found")
    expense_item = session.get(ExpenseItem, match.expense_item_id)
    bank_transaction = session.get(BankTransaction, match.bank_transaction_id)
    if expense_item is None or bank_transaction is None:
        raise HTTPException(status_code=409, detail="Matched source record is missing")
    ensure_store_access(session, current_user, expense_item.store_id)
    ensure_store_access(session, current_user, bank_transaction.store_id)
    if match.status == MatchStatus.CONFIRMED.value:
        return ApiEnvelope(data=match)
    if match.status == MatchStatus.REJECTED.value:
        raise HTTPException(status_code=409, detail="Rejected match cannot be confirmed")
    confirmed_expense_amount = confirmed_expense_match_amount(session, expense_item.id, exclude_match_id=match.id)
    validate_expense_bank_match_amount(
        session,
        expense_item=expense_item,
        bank_transaction=bank_transaction,
        amount=match.amount,
        exclude_match_id=match.id,
    )

    match.status = MatchStatus.CONFIRMED.value
    match.confirmed_by = operator
    match.confirmed_at = utc_now()
    if not bank_transaction.store_id and not bank_transaction.ledger_period:
        bank_transaction.store_id = expense_item.store_id
        bank_transaction.ledger_period = match.accounting_period or expense_item.ledger_period
    if not match.accounting_period:
        match.accounting_period = bank_transaction.ledger_period or expense_item.ledger_period
    bank_transaction.matched_amount = confirmed_bank_match_amount(session, bank_transaction.id, exclude_match_id=match.id) + match.amount
    if confirmed_expense_amount + match.amount >= Decimal(expense_item.amount):
        expense_item.payment_status = ExpensePaymentStatus.PAID.value
    else:
        expense_item.payment_status = ExpensePaymentStatus.PARTIAL_PAID.value
    refresh_approval_processing_status(session, expense_item.approval_instance_id)
    write_audit_log(
        session,
        actor=audit_actor(current_user, operator),
        action="match.confirm",
        resource_type="expense_bank_match",
        resource_id=match.id,
        summary="确认流水匹配",
        metadata={
            "expense_item_id": match.expense_item_id,
            "bank_transaction_id": match.bank_transaction_id,
            "amount": match.amount,
        },
    )
    session.commit()
    session.refresh(match)
    return ApiEnvelope(data=match)


@router.post("/{match_id}/reject", response_model=ApiEnvelope[MatchRead])
def reject_match(
    match_id: str,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[MatchRead]:
    ensure_permission(session, current_user, "reconciliation.manage")
    match = session.get(ExpenseBankMatch, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Match not found")
    expense_item = session.get(ExpenseItem, match.expense_item_id)
    bank_transaction = session.get(BankTransaction, match.bank_transaction_id)
    if expense_item is None or bank_transaction is None:
        raise HTTPException(status_code=409, detail="Matched source record is missing")
    ensure_store_access(session, current_user, expense_item.store_id)
    ensure_store_access(session, current_user, bank_transaction.store_id)
    if match.status == MatchStatus.CONFIRMED.value:
        raise HTTPException(status_code=409, detail="Confirmed match cannot be rejected")
    match.status = MatchStatus.REJECTED.value
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="match.reject",
        resource_type="expense_bank_match",
        resource_id=match.id,
        summary="驳回流水匹配候选",
    )
    session.commit()
    session.refresh(match)
    return ApiEnvelope(data=match)
