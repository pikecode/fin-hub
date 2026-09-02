from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

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
        confirmed_match_amount_by_item[match.expense_item_id] = (
            confirmed_match_amount_by_item.get(match.expense_item_id, Decimal("0.00"))
            + decimal_value(match.amount)
        )
    confirmed_match_amount = sum(confirmed_match_amount_by_item.values(), Decimal("0.00"))
    candidate_match_count = sum(1 for match in matches if match.status == MatchStatus.CANDIDATE.value)
    classified_count = sum(1 for item in expense_items if item.category_l1 or item.category_l2)
    matched_item_count = sum(
        1
        for item in expense_items
        if confirmed_match_amount_by_item.get(item.id, Decimal("0.00")) >= decimal_value(item.amount)
    )
    pending_item_count = sum(
        1
        for item in expense_items
        if confirmed_match_amount_by_item.get(item.id, Decimal("0.00")) < decimal_value(item.amount)
    )
    sync_conflict_count = sum(
        1 for item in expense_items if item.sync_conflict_status and item.sync_conflict_status != "none"
    )
    total_expense_amount = sum((decimal_value(item.amount) for item in expense_items), Decimal("0.00"))
    if not expense_items:
        processing_status = "unparsed"
    elif sync_conflict_count:
        processing_status = "sync_conflict"
    elif classified_count < len(expense_items):
        processing_status = "pending_classification"
    elif pending_item_count == len(expense_items):
        processing_status = "pending_match"
    elif pending_item_count:
        processing_status = "partial_matched"
    else:
        processing_status = "matched"
    return {
        "expense_item_count": len(expense_items),
        "classified_expense_item_count": classified_count,
        "matched_expense_item_count": matched_item_count,
        "pending_expense_item_count": pending_item_count,
        "sync_conflict_expense_item_count": sync_conflict_count,
        "total_expense_amount": total_expense_amount,
        "confirmed_match_amount": confirmed_match_amount,
        "candidate_match_count": candidate_match_count,
        "processing_status": processing_status,
    }


def canonical_expense_items(expense_items: list[ExpenseItem]) -> list[ExpenseItem]:
    """Exclude a synced whole-approval summary when line items exist for it."""
    line_document_bases = {
        item.source_document_id.split(":", 1)[0]
        for item in expense_items
        if item.source == "dingtalk"
        and item.source_document_id
        and ":" in item.source_document_id
    }
    return [
        item
        for item in expense_items
        if not (
            item.source == "dingtalk"
            and item.source_document_id
            and ":" not in item.source_document_id
            and item.source_document_id in line_document_bases
        )
    ]


def approval_expense_stats_map(
    session: Session,
    approval_ids: list[str],
) -> dict[str, dict[str, Any]]:
    if not approval_ids:
        return {}
    expense_items = list(
        session.scalars(select(ExpenseItem).where(ExpenseItem.approval_instance_id.in_(approval_ids)))
    )
    expense_items = canonical_expense_items(expense_items)
    expenses_by_approval_id: dict[str, list[ExpenseItem]] = {}
    for item in expense_items:
        if item.approval_instance_id:
            expenses_by_approval_id.setdefault(item.approval_instance_id, []).append(item)
    expense_ids = [item.id for item in expense_items]
    matches = (
        list(
            session.scalars(
                select(ExpenseBankMatch).where(ExpenseBankMatch.expense_item_id.in_(expense_ids))
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
            match
            for item in approval_expenses
            for match in matches_by_expense_id.get(item.id, [])
        ]
        result[approval_id] = approval_expense_stats(approval_expenses, approval_matches)
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
    stats = approval_expense_stats_map(session, [approval_id]).get(approval_id, approval_expense_stats([], []))
    instance.processing_status = stats["processing_status"]
    if stats["expense_item_count"] > 0 and instance.parse_status in {None, "unparsed", "skipped"}:
        instance.parse_status = "parsed"
        instance.parse_error = None
    return instance.processing_status
