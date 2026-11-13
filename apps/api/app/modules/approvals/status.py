from decimal import Decimal
from typing import Any

from sqlalchemy import and_, exists, func, or_, select
from sqlalchemy.orm import Session, aliased

from app.models import ApprovalInstance, ExpenseBankMatch, ExpenseItem, MatchStatus


def decimal_value(value: Any) -> Decimal:
    if value is None:
        return Decimal("0.00")
    return Decimal(str(value))


def approval_expense_stats(
    expense_items: list[ExpenseItem],
    matches: list[ExpenseBankMatch],
) -> dict[str, Any]:
    confirmed_match_amount_by_item: dict[str, Decimal] = {}
    for match in matches:
        if match.status != MatchStatus.CONFIRMED.value:
            continue
        confirmed_match_amount_by_item[match.expense_item_id] = confirmed_match_amount_by_item.get(
            match.expense_item_id, Decimal("0.00")
        ) + decimal_value(match.amount)
    confirmed_match_amount = sum(confirmed_match_amount_by_item.values(), Decimal("0.00"))
    candidate_match_count = sum(
        1 for match in matches if match.status == MatchStatus.CANDIDATE.value
    )
    classified_count = sum(
        1
        for item in expense_items
        if item.category_l1 or item.category_l2 or item.preopening_category_id
    )
    matched_item_count = sum(
        1
        for item in expense_items
        if confirmed_match_amount_by_item.get(item.id, Decimal("0.00"))
        >= decimal_value(item.amount)
    )
    pending_item_count = sum(
        1
        for item in expense_items
        if confirmed_match_amount_by_item.get(item.id, Decimal("0.00")) < decimal_value(item.amount)
    )
    sync_conflict_count = sum(
        1
        for item in expense_items
        if item.sync_conflict_status and item.sync_conflict_status != "none"
    )
    total_expense_amount = sum(
        (decimal_value(item.amount) for item in expense_items), Decimal("0.00")
    )
    if not expense_items:
        processing_status = "unparsed"
    elif sync_conflict_count:
        processing_status = "sync_conflict"
    elif classified_count < len(expense_items):
        processing_status = "pending_classification"
    elif total_expense_amount > 0 and confirmed_match_amount >= total_expense_amount:
        processing_status = "matched"
    elif confirmed_match_amount > 0:
        processing_status = "partial_matched"
    else:
        processing_status = "pending_match"
    return {
        "expense_item_count": len(expense_items),
        "classified_expense_item_count": classified_count,
        "matched_expense_item_count": matched_item_count,
        "pending_expense_item_count": pending_item_count,
        "sync_conflict_expense_item_count": sync_conflict_count,
        "total_expense_amount": total_expense_amount,
        "confirmed_match_amount": confirmed_match_amount,
        "candidate_match_count": candidate_match_count,
        "confirmed_match_count": sum(
            1 for match in matches if match.status == MatchStatus.CONFIRMED.value
        ),
        "confirmed_payment_count": len(
            {
                match.bank_transaction_id
                for match in matches
                if match.status == MatchStatus.CONFIRMED.value
            }
        ),
        "remaining_match_amount": max(
            total_expense_amount - confirmed_match_amount, Decimal("0.00")
        ),
        "processing_status": processing_status,
    }


def canonical_expense_condition():
    """Exclude obsolete unmatched lines and duplicate whole-approval summaries."""
    line = aliased(ExpenseItem)
    has_lines = exists(
        select(line.id).where(
            line.store_id == ExpenseItem.store_id,
            line.expense_scope == ExpenseItem.expense_scope,
            line.source == "dingtalk",
            func.starts_with(line.source_document_id, ExpenseItem.source_document_id + ":"),
        )
    )
    return and_(
        or_(
            ExpenseItem.sync_conflict_status.is_(None),
            ExpenseItem.sync_conflict_status != "source_removed",
        ),
        ~and_(
            ExpenseItem.source == "dingtalk",
            ExpenseItem.source_document_id.is_not(None),
            ~ExpenseItem.source_document_id.contains(":"),
            has_lines,
        ),
    )


def canonical_expense_items(expense_items: list[ExpenseItem]) -> list[ExpenseItem]:
    """Keep current lines and matched conflicts retained for financial review."""
    line_document_bases = {
        item.source_document_id.split(":", 1)[0]
        for item in expense_items
        if item.source == "dingtalk" and item.source_document_id and ":" in item.source_document_id
    }
    return [
        item
        for item in expense_items
        if item.sync_conflict_status != "source_removed"
        and not (
            item.source == "dingtalk"
            and item.source_document_id
            and ":" not in item.source_document_id
            and item.source_document_id in line_document_bases
        )
    ]


def approval_expense_stats_map(
    session: Session,
    approval_ids: list[str],
    *,
    exclude_match_id: str | None = None,
) -> dict[str, dict[str, Any]]:
    if not approval_ids:
        return {}
    expense_rows = session.execute(
        select(ExpenseItem, ApprovalInstance.id)
        .join(
            ApprovalInstance,
            or_(
                ExpenseItem.approval_instance_id == ApprovalInstance.id,
                and_(
                    ExpenseItem.approval_instance_id.is_(None),
                    or_(
                        ExpenseItem.source_document_id == ApprovalInstance.dingtalk_instance_id,
                        func.starts_with(
                            ExpenseItem.source_document_id,
                            ApprovalInstance.dingtalk_instance_id + ":",
                        ),
                    ),
                ),
            ),
        )
        .where(ApprovalInstance.id.in_(approval_ids))
    ).all()
    expense_items = [row[0] for row in expense_rows]
    expenses_by_approval_id: dict[str, list[ExpenseItem]] = {}
    for item, approval_id in expense_rows:
        expenses_by_approval_id.setdefault(approval_id, []).append(item)
    expense_ids = [item.id for item in expense_items]
    matches = (
        list(
            session.scalars(
                select(ExpenseBankMatch).where(
                    ExpenseBankMatch.expense_item_id.in_(expense_ids),
                    *([ExpenseBankMatch.id != exclude_match_id] if exclude_match_id else []),
                )
            )
        )
        if expense_ids
        else []
    )
    matches_by_expense_id: dict[str, list[ExpenseBankMatch]] = {}
    for match in matches:
        matches_by_expense_id.setdefault(match.expense_item_id, []).append(match)
    result: dict[str, dict[str, Any]] = {}
    for approval_id in approval_ids:
        approval_expenses = expenses_by_approval_id.get(approval_id, [])
        approval_matches = [
            match for item in approval_expenses for match in matches_by_expense_id.get(item.id, [])
        ]
        result[approval_id] = approval_expense_stats(
            canonical_expense_items(approval_expenses), approval_matches
        )
    return result


def refresh_approval_processing_status(
    session: Session,
    approval_id: str | None,
) -> str | None:
    if not approval_id:
        return None
    instance = session.get(ApprovalInstance, approval_id)
    if instance is None:
        return None
    stats = approval_expense_stats_map(session, [approval_id]).get(
        approval_id, approval_expense_stats([], [])
    )
    if instance.processing_status != "manual_matched":
        instance.processing_status = stats["processing_status"]
    if stats["expense_item_count"] > 0 and instance.parse_status in {None, "unparsed", "skipped"}:
        instance.parse_status = "parsed"
        instance.parse_error = None
    return instance.processing_status
