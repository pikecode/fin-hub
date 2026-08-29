import csv
import io
from decimal import Decimal

from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import StreamingResponse
from openpyxl import Workbook
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.models import (
    BankTransaction,
    ExpenseItem,
    Ledger,
    RevenueRecord,
    ShareholderAccessGrant,
    Store,
    User,
)
from app.modules.auth.router import get_optional_current_user
from app.modules.shareholder_auth.service import grant_store_ids, require_shareholder_grant
from app.schemas import (
    ApiEnvelope,
    ExpenseBreakdownItem,
    LedgerPeriodOption,
    LedgerReportDetail,
    LedgerReportSummary,
    LedgerTrend,
    StoreComparisonReport,
    StoreReportSummary,
)

router = APIRouter(prefix="/reports", tags=["reports"])


def read_bearer_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    prefix = "Bearer "
    if not authorization.startswith(prefix):
        raise HTTPException(status_code=401, detail="Invalid authorization header")
    return authorization.removeprefix(prefix)


def get_report_access(
    authorization: str | None = Header(default=None),
    current_user: User | None = Depends(get_optional_current_user),
    session: Session = Depends(get_session),
) -> ShareholderAccessGrant | None:
    if current_user is not None:
        return None
    token = read_bearer_token(authorization)
    if token is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return require_shareholder_grant(session, token)


def ensure_report_store_access(grant: ShareholderAccessGrant | None, store_id: str) -> None:
    if grant is None:
        return
    if store_id not in grant_store_ids(grant):
        raise HTTPException(status_code=403, detail="Store is not authorized")


def ensure_shareholder_can_read_ledger(grant: ShareholderAccessGrant | None, ledger: Ledger) -> None:
    if grant is not None and ledger.status != "closed":
        raise HTTPException(status_code=403, detail="Ledger is not closed")


def decimal_sum(value: Decimal | None) -> Decimal:
    return value if value is not None else Decimal("0.00")


def decimal_cell(value: Decimal | None) -> float:
    return float(decimal_sum(value))


def build_report_summary(session: Session, ledger: Ledger, store: Store) -> LedgerReportSummary:
    revenue_amount = decimal_sum(
        session.scalar(
            select(func.sum(RevenueRecord.gross_amount)).where(
                RevenueRecord.store_id == ledger.store_id,
                RevenueRecord.ledger_period == ledger.period,
            )
        )
    )
    bank_income_amount = decimal_sum(
        session.scalar(
            select(func.sum(BankTransaction.amount)).where(
                BankTransaction.store_id == ledger.store_id,
                BankTransaction.ledger_period == ledger.period,
                BankTransaction.direction == "income",
            )
        )
    )
    income_amount = revenue_amount if revenue_amount > 0 else bank_income_amount
    expense_amount = decimal_sum(
        session.scalar(
            select(func.sum(ExpenseItem.amount)).where(
                ExpenseItem.store_id == ledger.store_id,
                ExpenseItem.ledger_period == ledger.period,
            )
        )
    )
    pending_expense_count = session.scalar(
        select(func.count()).select_from(ExpenseItem).where(
            ExpenseItem.store_id == ledger.store_id,
            ExpenseItem.ledger_period == ledger.period,
            ExpenseItem.payment_status.in_(["unpaid", "partial_paid"]),
        )
    )
    pending_bank_count = session.scalar(
        select(func.count()).select_from(BankTransaction).where(
            BankTransaction.store_id == ledger.store_id,
            BankTransaction.ledger_period == ledger.period,
            BankTransaction.matched_amount < BankTransaction.amount,
        )
    )
    return LedgerReportSummary(
        store_id=store.id,
        store_name=store.name,
        period=ledger.period,
        ledger_status=ledger.status,
        income_amount=income_amount,
        expense_amount=expense_amount,
        profit_amount=income_amount - expense_amount,
        pending_expense_count=pending_expense_count or 0,
        pending_bank_transaction_count=pending_bank_count or 0,
    )


def read_ledger_for_report(
    session: Session,
    store_id: str,
    period: str,
    shareholder_grant: ShareholderAccessGrant | None,
) -> tuple[Store, Ledger]:
    ensure_report_store_access(shareholder_grant, store_id)
    store = session.get(Store, store_id)
    if store is None:
        raise HTTPException(status_code=404, detail="Store not found")
    ledger = session.scalar(select(Ledger).where(Ledger.store_id == store_id, Ledger.period == period))
    if ledger is None:
        raise HTTPException(status_code=404, detail="Ledger not found")
    ensure_shareholder_can_read_ledger(shareholder_grant, ledger)
    return store, ledger


def read_ledger_export_rows(
    session: Session,
    store_id: str,
    period: str,
) -> tuple[list[RevenueRecord], list[ExpenseItem], list[BankTransaction]]:
    revenue_records = session.scalars(
        select(RevenueRecord)
        .where(RevenueRecord.store_id == store_id, RevenueRecord.ledger_period == period)
        .order_by(RevenueRecord.revenue_date.asc(), RevenueRecord.created_at.asc())
    ).all()
    expenses = session.scalars(
        select(ExpenseItem)
        .where(ExpenseItem.store_id == store_id, ExpenseItem.ledger_period == period)
        .order_by(ExpenseItem.expense_date.asc(), ExpenseItem.created_at.asc())
    ).all()
    bank_transactions = session.scalars(
        select(BankTransaction)
        .where(BankTransaction.store_id == store_id, BankTransaction.ledger_period == period)
        .order_by(BankTransaction.occurred_at.asc())
    ).all()
    return list(revenue_records), list(expenses), list(bank_transactions)


@router.get("/store-summaries", response_model=ApiEnvelope[list[StoreReportSummary]])
def list_store_summaries(
    session: Session = Depends(get_session),
    shareholder_grant: ShareholderAccessGrant | None = Depends(get_report_access),
) -> ApiEnvelope[list[StoreReportSummary]]:
    stores = session.scalars(select(Store).order_by(Store.created_at.desc())).all()
    if shareholder_grant is not None:
        allowed_store_ids = set(grant_store_ids(shareholder_grant))
        stores = [store for store in stores if store.id in allowed_store_ids]
    summaries: list[StoreReportSummary] = []
    for store in stores:
        ledger_query = select(Ledger).where(Ledger.store_id == store.id)
        if shareholder_grant is not None:
            ledger_query = ledger_query.where(Ledger.status == "closed")
        ledger = session.scalar(
            ledger_query.order_by(Ledger.period.desc(), Ledger.created_at.desc())
        )
        if ledger is None:
            continue
        summary = build_report_summary(session, ledger, store)
        summaries.append(StoreReportSummary(**summary.model_dump(), ledger_id=ledger.id))
    return ApiEnvelope(data=summaries)


@router.get("/ledger-periods", response_model=ApiEnvelope[list[LedgerPeriodOption]])
def list_ledger_periods(
    store_id: str,
    session: Session = Depends(get_session),
    shareholder_grant: ShareholderAccessGrant | None = Depends(get_report_access),
) -> ApiEnvelope[list[LedgerPeriodOption]]:
    ensure_report_store_access(shareholder_grant, store_id)
    store = session.get(Store, store_id)
    if store is None:
        raise HTTPException(status_code=404, detail="Store not found")
    query = select(Ledger).where(Ledger.store_id == store_id)
    if shareholder_grant is not None:
        query = query.where(Ledger.status == "closed")
    ledgers = session.scalars(query.order_by(Ledger.period.desc(), Ledger.created_at.desc())).all()
    return ApiEnvelope(
        data=[
            LedgerPeriodOption(
                ledger_id=ledger.id,
                store_id=ledger.store_id,
                period=ledger.period,
                ledger_status=ledger.status,
            )
            for ledger in ledgers
        ]
    )


@router.get("/ledger-trends", response_model=ApiEnvelope[list[LedgerTrend]])
def list_ledger_trends(
    store_id: str | None = None,
    limit: int = 6,
    session: Session = Depends(get_session),
    shareholder_grant: ShareholderAccessGrant | None = Depends(get_report_access),
) -> ApiEnvelope[list[LedgerTrend]]:
    limit = min(max(limit, 1), 24)
    stores_query = select(Store).order_by(Store.created_at.desc())
    if store_id:
        ensure_report_store_access(shareholder_grant, store_id)
        stores_query = stores_query.where(Store.id == store_id)
    stores = session.scalars(stores_query).all()
    if shareholder_grant is not None:
        allowed_store_ids = set(grant_store_ids(shareholder_grant))
        stores = [store for store in stores if store.id in allowed_store_ids]

    trends: list[LedgerTrend] = []
    for store in stores:
        ledger_query = select(Ledger).where(Ledger.store_id == store.id)
        if shareholder_grant is not None:
            ledger_query = ledger_query.where(Ledger.status == "closed")
        ledgers = session.scalars(
            ledger_query.order_by(Ledger.period.desc(), Ledger.created_at.desc()).limit(limit)
        ).all()
        if not ledgers:
            continue
        summaries = [build_report_summary(session, ledger, store) for ledger in reversed(ledgers)]
        trends.append(LedgerTrend(store_id=store.id, store_name=store.name, items=summaries))
    return ApiEnvelope(data=trends)


@router.get("/store-comparison", response_model=ApiEnvelope[StoreComparisonReport])
def read_store_comparison(
    period: str | None = None,
    session: Session = Depends(get_session),
    shareholder_grant: ShareholderAccessGrant | None = Depends(get_report_access),
) -> ApiEnvelope[StoreComparisonReport]:
    allowed_store_ids: set[str] | None = None
    if shareholder_grant is not None:
        allowed_store_ids = set(grant_store_ids(shareholder_grant))

    period_query = select(func.max(Ledger.period))
    if shareholder_grant is not None:
        period_query = period_query.where(Ledger.status == "closed")
    if allowed_store_ids is not None:
        period_query = period_query.where(Ledger.store_id.in_(allowed_store_ids))
    target_period = period or session.scalar(period_query)
    if not target_period:
        raise HTTPException(status_code=404, detail="No ledger period available")

    ledger_query = select(Ledger).where(Ledger.period == target_period)
    if shareholder_grant is not None:
        ledger_query = ledger_query.where(Ledger.status == "closed")
    if allowed_store_ids is not None:
        ledger_query = ledger_query.where(Ledger.store_id.in_(allowed_store_ids))
    ledgers = session.scalars(ledger_query.order_by(Ledger.created_at.desc())).all()
    summaries: list[LedgerReportSummary] = []
    for ledger in ledgers:
        store = session.get(Store, ledger.store_id)
        if store is None:
            continue
        summaries.append(build_report_summary(session, ledger, store))
    summaries.sort(key=lambda item: item.profit_amount, reverse=True)
    return ApiEnvelope(
        data=StoreComparisonReport(
            period=target_period,
            items=summaries,
            total_income_amount=sum((item.income_amount for item in summaries), Decimal("0.00")),
            total_expense_amount=sum((item.expense_amount for item in summaries), Decimal("0.00")),
            total_profit_amount=sum((item.profit_amount for item in summaries), Decimal("0.00")),
        )
    )


@router.get("/ledger-summary", response_model=ApiEnvelope[LedgerReportSummary])
def read_ledger_summary(
    store_id: str,
    period: str,
    session: Session = Depends(get_session),
    shareholder_grant: ShareholderAccessGrant | None = Depends(get_report_access),
) -> ApiEnvelope[LedgerReportSummary]:
    store, ledger = read_ledger_for_report(session, store_id, period, shareholder_grant)
    return ApiEnvelope(data=build_report_summary(session, ledger, store))


@router.get("/ledger-detail", response_model=ApiEnvelope[LedgerReportDetail])
def read_ledger_detail(
    store_id: str,
    period: str,
    session: Session = Depends(get_session),
    shareholder_grant: ShareholderAccessGrant | None = Depends(get_report_access),
) -> ApiEnvelope[LedgerReportDetail]:
    store, ledger = read_ledger_for_report(session, store_id, period, shareholder_grant)

    category_rows = session.execute(
        select(
            func.coalesce(ExpenseItem.category_l1, "未分类"),
            func.sum(ExpenseItem.amount),
            func.count(),
        )
        .where(ExpenseItem.store_id == store_id, ExpenseItem.ledger_period == period)
        .group_by(func.coalesce(ExpenseItem.category_l1, "未分类"))
        .order_by(func.sum(ExpenseItem.amount).desc())
    ).all()
    supplier_rows = session.execute(
        select(
            func.coalesce(ExpenseItem.supplier_name, "未关联供应商"),
            func.sum(ExpenseItem.amount),
            func.count(),
        )
        .where(ExpenseItem.store_id == store_id, ExpenseItem.ledger_period == period)
        .group_by(func.coalesce(ExpenseItem.supplier_name, "未关联供应商"))
        .order_by(func.sum(ExpenseItem.amount).desc())
    ).all()
    pending_expense_items = session.scalars(
        select(ExpenseItem)
        .where(
            ExpenseItem.store_id == store_id,
            ExpenseItem.ledger_period == period,
            ExpenseItem.payment_status.in_(["unpaid", "partial_paid"]),
        )
        .order_by(ExpenseItem.created_at.desc())
        .limit(20)
    ).all()
    pending_bank_transactions = session.scalars(
        select(BankTransaction)
        .where(
            BankTransaction.store_id == store_id,
            BankTransaction.ledger_period == period,
            BankTransaction.matched_amount < BankTransaction.amount,
        )
        .order_by(BankTransaction.occurred_at.desc())
        .limit(20)
    ).all()
    revenue_records = session.scalars(
        select(RevenueRecord)
        .where(RevenueRecord.store_id == store_id, RevenueRecord.ledger_period == period)
        .order_by(RevenueRecord.revenue_date.desc(), RevenueRecord.created_at.desc())
        .limit(50)
    ).all()

    return ApiEnvelope(
        data=LedgerReportDetail(
            summary=build_report_summary(session, ledger, store),
            revenue_records=list(revenue_records),
            category_breakdown=[
                ExpenseBreakdownItem(name=name, amount=decimal_sum(amount), item_count=count)
                for name, amount, count in category_rows
            ],
            supplier_breakdown=[
                ExpenseBreakdownItem(name=name, amount=decimal_sum(amount), item_count=count)
                for name, amount, count in supplier_rows
            ],
            pending_expense_items=list(pending_expense_items),
            pending_bank_transactions=list(pending_bank_transactions),
        )
    )


@router.get("/ledger-detail.csv")
def export_ledger_detail_csv(
    store_id: str,
    period: str,
    session: Session = Depends(get_session),
    shareholder_grant: ShareholderAccessGrant | None = Depends(get_report_access),
) -> StreamingResponse:
    store, ledger = read_ledger_for_report(session, store_id, period, shareholder_grant)
    revenue_records, expenses, bank_transactions = read_ledger_export_rows(session, store_id, period)
    summary = build_report_summary(session, ledger, store)

    buffer = io.StringIO()
    buffer.write("\ufeff")
    writer = csv.writer(buffer)
    writer.writerow(["报表类型", "门店", "账期", "账套状态", "收入", "支出", "利润"])
    writer.writerow(
        [
            "账套汇总",
            summary.store_name,
            summary.period,
            summary.ledger_status,
            summary.income_amount,
            summary.expense_amount,
            summary.profit_amount,
        ]
    )
    writer.writerow([])
    writer.writerow(["营业收入"])
    writer.writerow(["日期", "渠道", "经营收入", "实收金额", "手续费", "备注"])
    for record in revenue_records:
        writer.writerow(
            [
                record.revenue_date.isoformat(),
                record.channel,
                record.gross_amount,
                record.net_amount,
                record.fee_amount,
                record.remark or "",
            ]
        )
    writer.writerow([])
    writer.writerow(["支出明细"])
    writer.writerow(["日期", "说明", "金额", "一级分类", "二级分类", "供应商", "收款账号", "付款状态"])
    for item in expenses:
        writer.writerow(
            [
                item.expense_date.isoformat() if item.expense_date else "",
                item.description,
                item.amount,
                item.category_l1 or "",
                item.category_l2 or "",
                item.supplier_name or "",
                item.payee_account or "",
                item.payment_status,
            ]
        )
    writer.writerow([])
    writer.writerow(["银行流水"])
    writer.writerow(["发生时间", "方向", "金额", "对方户名", "对方账号", "摘要", "流水号", "已匹配金额"])
    for transaction in bank_transactions:
        writer.writerow(
            [
                transaction.occurred_at.isoformat(sep=" "),
                transaction.direction,
                transaction.amount,
                transaction.counterparty_name or "",
                transaction.counterparty_account or "",
                transaction.summary or "",
                transaction.bank_serial_no or "",
                transaction.matched_amount,
            ]
        )
    buffer.seek(0)
    filename = f"ledger-detail-{store_id}-{period}.csv"
    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def append_rows(sheet, rows: list[list[object]]) -> None:
    for row in rows:
        sheet.append(row)


@router.get("/ledger-detail.xlsx")
def export_ledger_detail_xlsx(
    store_id: str,
    period: str,
    session: Session = Depends(get_session),
    shareholder_grant: ShareholderAccessGrant | None = Depends(get_report_access),
) -> StreamingResponse:
    store, ledger = read_ledger_for_report(session, store_id, period, shareholder_grant)
    revenue_records, expenses, bank_transactions = read_ledger_export_rows(session, store_id, period)
    summary = build_report_summary(session, ledger, store)

    workbook = Workbook()
    summary_sheet = workbook.active
    summary_sheet.title = "账套汇总"
    append_rows(
        summary_sheet,
        [
            ["门店", summary.store_name],
            ["账期", summary.period],
            ["账套状态", summary.ledger_status],
            ["收入", decimal_cell(summary.income_amount)],
            ["支出", decimal_cell(summary.expense_amount)],
            ["利润", decimal_cell(summary.profit_amount)],
            ["待付款支出", summary.pending_expense_count],
            ["未匹配流水", summary.pending_bank_transaction_count],
        ],
    )

    revenue_sheet = workbook.create_sheet("营业收入")
    revenue_sheet.append(["日期", "渠道", "经营收入", "实收金额", "手续费", "备注"])
    for record in revenue_records:
        revenue_sheet.append(
            [
                record.revenue_date.isoformat(),
                record.channel,
                decimal_cell(record.gross_amount),
                decimal_cell(record.net_amount),
                decimal_cell(record.fee_amount),
                record.remark or "",
            ]
        )

    expense_sheet = workbook.create_sheet("支出明细")
    expense_sheet.append(["日期", "说明", "金额", "一级分类", "二级分类", "供应商", "收款账号", "付款状态"])
    for item in expenses:
        expense_sheet.append(
            [
                item.expense_date.isoformat() if item.expense_date else "",
                item.description,
                decimal_cell(item.amount),
                item.category_l1 or "",
                item.category_l2 or "",
                item.supplier_name or "",
                item.payee_account or "",
                item.payment_status,
            ]
        )

    bank_sheet = workbook.create_sheet("银行流水")
    bank_sheet.append(["发生时间", "方向", "金额", "对方户名", "对方账号", "摘要", "流水号", "已匹配金额"])
    for transaction in bank_transactions:
        bank_sheet.append(
            [
                transaction.occurred_at.isoformat(sep=" "),
                transaction.direction,
                decimal_cell(transaction.amount),
                transaction.counterparty_name or "",
                transaction.counterparty_account or "",
                transaction.summary or "",
                transaction.bank_serial_no or "",
                decimal_cell(transaction.matched_amount),
            ]
        )

    for sheet in workbook.worksheets:
        sheet.freeze_panes = "A2"
        for column_cells in sheet.columns:
            width = max(len(str(cell.value or "")) for cell in column_cells)
            sheet.column_dimensions[column_cells[0].column_letter].width = min(max(width + 2, 12), 36)

    output = io.BytesIO()
    workbook.save(output)
    output.seek(0)
    filename = f"ledger-detail-{store_id}-{period}.xlsx"
    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
