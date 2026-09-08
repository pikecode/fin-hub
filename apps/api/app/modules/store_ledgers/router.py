from datetime import datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.models import (
    ApprovalInstance,
    ApprovalTemplate,
    BankTransaction,
    ExpenseCategory,
    ExpenseItem,
    ExpenseBankMatch,
    Ledger,
    MatchStatus,
    RevenueBankMatch,
    RevenueBankMatchRecord,
    RevenueRecord,
    Store,
    User,
    utc_now,
)
from app.modules.approvals.status import approval_expense_stats_map
from app.modules.auth.permissions import ensure_permission, ensure_store_access
from app.modules.auth.router import get_current_user
from app.modules.dingtalk.router import approval_instance_read
from app.modules.ledgers.router import build_close_check
from app.modules.matching.router import (
    approval_expense_join_condition,
    revenue_match_record_ids_map,
    revenue_match_response,
)
from app.schemas import ApiEnvelope, StoreLedgerWorkspaceMetrics, StoreLedgerWorkspaceRead

router = APIRouter(prefix="/store-ledgers", tags=["store-ledgers"])
REVENUE_FEE_SOURCE = "revenue_fee"
FOOD_COST_CATEGORY_L1 = "食材成本"


def decimal_sum(value: Decimal | None) -> Decimal:
    return value if value is not None else Decimal("0.00")


def decimal_rate(numerator: Decimal, denominator: Decimal) -> Decimal:
    if denominator <= 0:
        return Decimal("0.00")
    return (numerator / denominator * Decimal("100")).quantize(Decimal("0.01"))


def parse_period_start(period: str) -> datetime:
    year, month = (int(part) for part in period.split("-"))
    return datetime(year, month, 1)


def next_period_start(period: str) -> datetime:
    start = parse_period_start(period)
    if start.month == 12:
        return datetime(start.year + 1, 1, 1)
    return datetime(start.year, start.month + 1, 1)


def previous_period(period: str) -> str:
    start = parse_period_start(period)
    if start.month == 1:
        return f"{start.year - 1}-12"
    return f"{start.year}-{start.month - 1:02d}"


def latest_period(ledgers: list[Ledger], requested_period: str | None) -> str:
    if requested_period:
        return requested_period
    if ledgers:
        return ledgers[0].period
    return utc_now().date().strftime("%Y-%m")


@router.get("/{store_id}/workspace", response_model=ApiEnvelope[StoreLedgerWorkspaceRead])
def read_store_ledger_workspace(
    store_id: str,
    period: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}$"),
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[StoreLedgerWorkspaceRead]:
    ensure_permission(session, current_user, "stores.view")
    ensure_store_access(session, current_user, store_id)
    store = session.get(Store, store_id)
    if store is None:
        from fastapi import HTTPException

        raise HTTPException(status_code=404, detail="Store not found")

    ledgers = list(
        session.scalars(
            select(Ledger)
            .where(Ledger.store_id == store_id)
            .order_by(Ledger.period.desc(), Ledger.created_at.desc())
            .limit(200)
        )
    )
    selected_period = latest_period(ledgers, period)
    selected_ledger = next((ledger for ledger in ledgers if ledger.period == selected_period), None)
    period_start = parse_period_start(selected_period)
    next_start = next_period_start(selected_period)
    period_start_date = period_start.date()
    next_start_date = next_start.date()
    monthly_periods = [selected_period]
    monthly_cursor = selected_period
    for _ in range(5):
        monthly_cursor = previous_period(monthly_cursor)
        monthly_periods.append(monthly_cursor)
    monthly_periods = list(reversed(monthly_periods))

    revenue_record_count = session.scalar(
        select(func.count()).select_from(RevenueRecord).where(
            RevenueRecord.store_id == store_id,
            RevenueRecord.ledger_period == selected_period,
        )
    )
    revenue_channel_rows = session.execute(
        select(
            RevenueRecord.channel,
            func.coalesce(func.sum(RevenueRecord.gross_amount), 0),
            func.coalesce(func.sum(RevenueRecord.net_amount), 0),
            func.coalesce(func.sum(RevenueRecord.fee_amount), 0),
            func.count(),
        ).where(
            RevenueRecord.store_id == store_id,
            RevenueRecord.ledger_period == selected_period,
        ).group_by(RevenueRecord.channel)
    ).all()
    revenue_channel_monthly_rows = session.execute(
        select(
            RevenueRecord.ledger_period,
            RevenueRecord.channel,
            func.coalesce(func.sum(RevenueRecord.gross_amount), 0),
            func.coalesce(func.sum(RevenueRecord.net_amount), 0),
            func.count(),
        ).where(
            RevenueRecord.store_id == store_id,
            RevenueRecord.ledger_period.in_(monthly_periods),
        ).group_by(RevenueRecord.ledger_period, RevenueRecord.channel)
    ).all()
    revenue_channel_monthly_summary = [
        {
            "period": row[0],
            "channel": row[1],
            "gross_amount": decimal_sum(row[2]),
            "net_amount": decimal_sum(row[3]),
            "record_count": row[4],
        }
        for row in revenue_channel_monthly_rows
    ]
    income_amount = decimal_sum(
        session.scalar(
            select(func.sum(RevenueRecord.gross_amount)).where(
                RevenueRecord.store_id == store_id,
                RevenueRecord.ledger_period == selected_period,
            )
        )
    )
    net_income_amount = decimal_sum(
        session.scalar(
            select(func.sum(RevenueRecord.net_amount)).where(
                RevenueRecord.store_id == store_id,
                RevenueRecord.ledger_period == selected_period,
            )
        )
    )
    confirmed_expense_rows = session.execute(
        select(
            ExpenseItem.category_l1,
            ExpenseItem.category_l2,
            ExpenseBankMatch.amount,
        )
        .join(ExpenseBankMatch, ExpenseBankMatch.expense_item_id == ExpenseItem.id)
        .join(ApprovalInstance, approval_expense_join_condition())
        .where(
            ExpenseItem.store_id == store_id,
            ApprovalInstance.store_id == store_id,
            ExpenseBankMatch.status == MatchStatus.CONFIRMED.value,
            ExpenseBankMatch.accounting_period == selected_period,
            ExpenseItem.source != REVENUE_FEE_SOURCE,
        )
    ).all()
    revenue_fee_rows = session.execute(
        select(
            ExpenseItem.category_l1,
            ExpenseItem.category_l2,
            ExpenseItem.amount,
        )
        .where(
            ExpenseItem.store_id == store_id,
            ExpenseItem.ledger_period == selected_period,
            ExpenseItem.source == REVENUE_FEE_SOURCE,
        )
    ).all()
    expense_amount = sum(
        (decimal_sum(row[2]) for row in confirmed_expense_rows), Decimal("0.00")
    ) + sum((decimal_sum(row[2]) for row in revenue_fee_rows), Decimal("0.00"))
    food_cost_amount = sum(
        (
            decimal_sum(row[2])
            for row in confirmed_expense_rows
            if row[0] == FOOD_COST_CATEGORY_L1
        ),
        Decimal("0.00"),
    )
    gross_profit_amount = income_amount - food_cost_amount
    fee_amount = decimal_sum(
        session.scalar(
            select(func.sum(RevenueRecord.fee_amount)).where(
                RevenueRecord.store_id == store_id,
                RevenueRecord.ledger_period == selected_period,
            )
        )
    )
    revenue_net_amount = decimal_sum(
        session.scalar(
            select(func.sum(RevenueRecord.net_amount)).where(
                RevenueRecord.store_id == store_id,
                RevenueRecord.ledger_period == selected_period,
            )
        )
    )
    bank_transaction_count = session.scalar(
        select(func.count()).select_from(BankTransaction).where(
            BankTransaction.store_id == store_id,
            BankTransaction.ledger_period == selected_period,
        )
    )
    unmatched_bank_transaction_count = session.scalar(
        select(func.count()).select_from(BankTransaction).where(
            BankTransaction.store_id == store_id,
            BankTransaction.ledger_period == selected_period,
            func.coalesce(BankTransaction.matched_amount, 0) <= 0,
        )
    )
    matched_bank_amount = decimal_sum(
        session.scalar(
            select(func.sum(BankTransaction.matched_amount)).where(
                BankTransaction.store_id == store_id,
                BankTransaction.ledger_period == selected_period,
                BankTransaction.matched_amount > 0,
            )
        )
    )
    approval_instances = list(
        session.scalars(
            select(ApprovalInstance)
            .where(
                ApprovalInstance.store_id == store_id,
                ApprovalInstance.submit_at >= period_start,
                ApprovalInstance.submit_at < next_start,
                ApprovalInstance.approval_status.in_(["agree", "approved", "completed", "finish", "success"]),
            )
            .order_by(ApprovalInstance.submit_at.desc())
        )
    )
    approval_stats_by_id = approval_expense_stats_map(session, [item.id for item in approval_instances])
    approval_template_ids = [item.template_id for item in approval_instances]
    approval_templates = (
        list(session.scalars(select(ApprovalTemplate).where(ApprovalTemplate.id.in_(approval_template_ids))))
        if approval_template_ids
        else []
    )
    approval_templates_by_id = {template.id: template for template in approval_templates}
    approval_template_summary_map: dict[str, dict[str, Decimal | int | str]] = {}
    matched_approval_count = 0
    unmatched_approval_count = 0
    for item in approval_instances:
        stats = approval_stats_by_id.get(item.id, {})
        is_matched = stats.get("processing_status") in {"matched", "partial_matched"}
        if is_matched:
            matched_approval_count += 1
        else:
            unmatched_approval_count += 1
        template = approval_templates_by_id.get(item.template_id)
        template_name = template.name if template else item.template_id
        bucket = approval_template_summary_map.setdefault(
            item.template_id,
            {
                "template_id": item.template_id,
                "template_name": template_name,
                "approval_count": 0,
                "matched_count": 0,
                "unmatched_count": 0,
                "total_amount": Decimal("0.00"),
            },
        )
        bucket["approval_count"] = int(bucket["approval_count"]) + 1
        bucket["total_amount"] = decimal_sum(bucket["total_amount"]) + decimal_sum(stats.get("total_expense_amount"))
        if is_matched:
            bucket["matched_count"] = int(bucket["matched_count"]) + 1
        else:
            bucket["unmatched_count"] = int(bucket["unmatched_count"]) + 1
    approval_amount = sum(
        (
            approval_stats_by_id.get(item.id, {}).get("total_expense_amount")
            or Decimal("0.00")
        )
        for item in approval_instances
    )
    approval_accounting_amount = decimal_sum(
        session.scalar(
            select(func.sum(ExpenseBankMatch.amount))
            .join(ExpenseItem, ExpenseBankMatch.expense_item_id == ExpenseItem.id)
            .join(ApprovalInstance, approval_expense_join_condition())
            .where(
                ExpenseItem.store_id == store_id,
                ApprovalInstance.store_id == store_id,
                ExpenseBankMatch.status == MatchStatus.CONFIRMED.value,
                ExpenseBankMatch.accounting_period == selected_period,
                ExpenseItem.source != REVENUE_FEE_SOURCE,
            )
        )
    )
    pending_approval_count = sum(
        1
        for item in approval_instances
        if approval_stats_by_id.get(item.id, {}).get("processing_status") in {"unparsed", "pending_classification", "pending_match"}
    )
    active_category_rows = session.execute(
        select(
            ExpenseCategory.id,
            ExpenseCategory.name,
            ExpenseCategory.parent_id,
        ).where(
            ExpenseCategory.status == "active",
        )
    ).all()
    active_category_by_id = {
        category_id: {"name": name, "parent_id": parent_id}
        for category_id, name, parent_id in active_category_rows
    }
    active_root_names = {name for _, name, parent_id in active_category_rows if parent_id is None}
    active_child_pairs = {
        (parent_name, child_name)
        for _, child_name, parent_id in active_category_rows
        if parent_id is not None
        for parent in [active_category_by_id.get(parent_id)]
        if parent is not None and parent["parent_id"] is None
        for parent_name in [str(parent["name"])]
    }
    category_map: dict[tuple[str, str | None], dict[str, Decimal | int | str | None]] = {}
    for category_l1, category_l2, amount in [*confirmed_expense_rows, *revenue_fee_rows]:
        if not category_l1 or category_l1 not in active_root_names:
            continue
        if category_l2 and (category_l1, category_l2) not in active_child_pairs:
            continue
        l1 = category_l1
        l2 = category_l2
        key = (l1, l2)
        bucket = category_map.setdefault(
            key,
            {
                "name": " / ".join([part for part in [l1, l2] if part]) or "未分类",
                "amount": Decimal("0.00"),
                "item_count": 0,
            },
        )
        bucket["amount"] = decimal_sum(bucket["amount"]) + decimal_sum(amount)
        bucket["item_count"] = int(bucket["item_count"]) + 1
    expense_category_summary = sorted(
        category_map.values(),
        key=lambda item: decimal_sum(item["amount"]),
        reverse=True,
    )
    revenue_match_count = session.scalar(
        select(func.count()).select_from(RevenueBankMatch).join(
            BankTransaction,
            RevenueBankMatch.bank_transaction_id == BankTransaction.id,
        ).where(
            BankTransaction.store_id == store_id,
            BankTransaction.ledger_period == selected_period,
        )
    )
    pending_revenue_match_count = session.scalar(
        select(func.count()).select_from(RevenueBankMatch).join(
            BankTransaction,
            RevenueBankMatch.bank_transaction_id == BankTransaction.id,
        ).where(
            BankTransaction.store_id == store_id,
            BankTransaction.ledger_period == selected_period,
            RevenueBankMatch.status == MatchStatus.CANDIDATE.value,
        )
    )
    matched_channel_rows = session.execute(
        select(
            RevenueRecord.channel,
            func.coalesce(func.sum(RevenueRecord.net_amount), 0),
        )
        .join(RevenueBankMatchRecord, RevenueBankMatchRecord.revenue_record_id == RevenueRecord.id)
        .join(RevenueBankMatch, RevenueBankMatch.id == RevenueBankMatchRecord.revenue_bank_match_id)
        .join(BankTransaction, BankTransaction.id == RevenueBankMatch.bank_transaction_id)
        .where(
            RevenueRecord.store_id == store_id,
            RevenueRecord.ledger_period == selected_period,
            BankTransaction.store_id == store_id,
            RevenueBankMatch.status == MatchStatus.CONFIRMED.value,
        )
        .group_by(RevenueRecord.channel)
    ).all()
    matched_by_channel = {row[0]: decimal_sum(row[1]) for row in matched_channel_rows}
    revenue_channel_summary = []
    for row in revenue_channel_rows:
        gross_amount = decimal_sum(row[1])
        net_amount = decimal_sum(row[2])
        fee_amount_value = decimal_sum(row[3])
        matched_amount = min(matched_by_channel.get(row[0], Decimal("0.00")), net_amount)
        revenue_channel_summary.append(
            {
                "channel": row[0],
                "gross_amount": gross_amount,
                "net_amount": net_amount,
                "fee_amount": fee_amount_value,
                "fee_rate": decimal_rate(fee_amount_value, gross_amount),
                "matched_amount": matched_amount,
                "unmatched_amount": max(net_amount - matched_amount, Decimal("0.00")),
                "reconciliation_rate": decimal_rate(matched_amount, net_amount),
                "record_count": row[4],
            }
        )
    bank_transactions = list(
        session.scalars(
            select(BankTransaction)
            .where(BankTransaction.store_id == store_id, BankTransaction.ledger_period == selected_period)
            .order_by(BankTransaction.occurred_at.desc())
        )
    )
    revenue_records = list(
        session.scalars(
            select(RevenueRecord)
            .where(
                RevenueRecord.store_id == store_id,
                RevenueRecord.revenue_date >= period_start_date,
                RevenueRecord.revenue_date < next_start_date,
            )
            .order_by(RevenueRecord.revenue_date.desc(), RevenueRecord.created_at.desc())
        )
    )
    approval_reads = [
        approval_instance_read(session, item, approval_stats_by_id.get(item.id))
        for item in approval_instances
    ]
    revenue_matches = list(
        session.scalars(
            select(RevenueBankMatch)
            .join(BankTransaction, RevenueBankMatch.bank_transaction_id == BankTransaction.id)
            .where(BankTransaction.store_id == store_id, BankTransaction.ledger_period == selected_period)
            .order_by(RevenueBankMatch.created_at.desc())
        )
    )
    revenue_match_record_ids = revenue_match_record_ids_map(
        session,
        [match.id for match in revenue_matches],
    )
    revenue_match_reads = [
        revenue_match_response(session, match, revenue_match_record_ids.get(match.id, []))
        for match in revenue_matches
    ]

    return ApiEnvelope(
        data=StoreLedgerWorkspaceRead(
            store=store,
            period=selected_period,
            ledgers=ledgers,
            selected_ledger=selected_ledger,
            close_check=build_close_check(session, selected_ledger) if selected_ledger else None,
            metrics=StoreLedgerWorkspaceMetrics(
                revenue_record_count=revenue_record_count or 0,
                revenue_income_amount=income_amount,
                revenue_net_amount=revenue_net_amount,
                income_amount=income_amount,
                expense_amount=expense_amount,
                food_cost_amount=food_cost_amount,
                gross_profit_amount=gross_profit_amount,
                net_income_amount=net_income_amount,
                fee_amount=fee_amount,
                approval_amount=approval_amount,
                approval_accounting_amount=approval_accounting_amount,
                bank_transaction_count=bank_transaction_count or 0,
                matched_bank_amount=matched_bank_amount,
                unmatched_bank_transaction_count=unmatched_bank_transaction_count or 0,
                approval_count=len(approval_instances),
                matched_approval_count=matched_approval_count,
                unmatched_approval_count=unmatched_approval_count,
                pending_approval_count=pending_approval_count,
                revenue_match_count=revenue_match_count or 0,
                pending_revenue_match_count=pending_revenue_match_count or 0,
                expense_category_summary=expense_category_summary,
                revenue_channel_summary=revenue_channel_summary,
                revenue_channel_monthly_summary=revenue_channel_monthly_summary,
                approval_template_summary=sorted(
                    approval_template_summary_map.values(),
                    key=lambda item: (
                        -int(item["approval_count"]),
                        str(item["template_name"]),
                    ),
                ),
            ),
            bank_transactions=bank_transactions,
            revenue_records=revenue_records,
            approval_instances=approval_reads,
            revenue_matches=revenue_match_reads,
        )
    )
