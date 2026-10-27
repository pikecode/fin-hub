"""Audited replacement of unpaid bank plans by real payments, without splitting expenses."""

import json
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select, or_, func, text
from sqlalchemy.orm import Session, aliased

from app.core.database import get_session
from app.models import (
    BankTransaction,
    BankPaymentSettlement,
    BankPaymentSettlementLink,
    ExpenseBankMatch,
    RevenueBankMatch,
    Ledger,
    User,
    utc_now,
)
from app.schemas import ApiEnvelope, BankTransactionRead
from app.modules.auth.router import require_permission, audit_actor
from app.modules.auth.permissions import ensure_store_access
from app.modules.audit.service import write_audit_log

router = APIRouter(prefix="/bank-payment-settlements", tags=["bank-payment-settlements"])


class AddLinks(BaseModel):
    bank_transaction_ids: list[str] = Field(min_length=1, max_length=100)


class CompleteSettlement(BaseModel):
    confirm_difference: bool = False
    remark: str = Field(default="", max_length=1000)


def mutation_lock(session):
    if session.get_bind().dialect.name == "postgresql":
        session.execute(text("SELECT pg_advisory_xact_lock(2026102602)"))


def group_for(session, source_id):
    return session.scalar(
        select(BankPaymentSettlement).where(
            BankPaymentSettlement.source_bank_transaction_id == source_id
        )
    )


def linked_rows(session, group):
    if group is None:
        return []
    return session.execute(
        select(BankPaymentSettlementLink, BankTransaction)
        .join(BankTransaction, BankPaymentSettlementLink.bank_transaction_id == BankTransaction.id)
        .where(BankPaymentSettlementLink.settlement_id == group.id)
        .order_by(BankTransaction.occurred_at, BankTransaction.id)
    ).all()


def check_open(session, bank):
    from app.modules.preopening.service import protect_bank

    protect_bank(session, bank.id)
    periods = {bank.ledger_period, bank.occurred_at.strftime("%Y-%m")}
    if session.scalar(
        select(Ledger.id)
        .where(
            Ledger.store_id == bank.store_id, Ledger.period.in_(periods), Ledger.status == "closed"
        )
        .limit(1)
    ):
        raise HTTPException(409, "核对涉及的月份已封账，请先解封")


def source_bank(session, user, source_id, *, write=False):
    query = select(BankTransaction).where(BankTransaction.id == source_id)
    bank = session.scalar(query.with_for_update() if write else query)
    if bank is None:
        raise HTTPException(404, "未实付登记不存在")
    ensure_store_access(session, user, bank.store_id)
    group = group_for(session, bank.id)
    if bank.direction != "expense" or bank.payment_status != "unpaid" or bank.direct_posting_type:
        raise HTTPException(409, "仅支持未实付支出的核对")
    if write:
        if bank.is_archived or (group and group.status == "completed"):
            raise HTTPException(409, "该笔未实付已核对完成，不能重复操作")
        check_open(session, bank)
    return bank, group


def completed_payments(session, source_ids):
    rows = (
        session.execute(
            select(BankPaymentSettlement.source_bank_transaction_id, BankTransaction)
            .join(
                BankPaymentSettlementLink,
                BankPaymentSettlementLink.settlement_id == BankPaymentSettlement.id,
            )
            .join(
                BankTransaction, BankTransaction.id == BankPaymentSettlementLink.bank_transaction_id
            )
            .where(
                BankPaymentSettlement.source_bank_transaction_id.in_(source_ids),
                BankPaymentSettlement.status == "completed",
            )
            .order_by(BankTransaction.occurred_at, BankTransaction.id)
        ).all()
        if source_ids
        else []
    )
    result = {}
    for source_id, bank in rows:
        result.setdefault(source_id, []).append(bank)
    return result


def completed_source_ids(session, real_id):
    return list(
        session.scalars(
            select(BankPaymentSettlement.source_bank_transaction_id)
            .join(
                BankPaymentSettlementLink,
                BankPaymentSettlementLink.settlement_id == BankPaymentSettlement.id,
            )
            .where(
                BankPaymentSettlementLink.bank_transaction_id == real_id,
                BankPaymentSettlement.status == "completed",
            )
        )
    )


def reserved_payment_bank_ids():
    return (
        select(BankPaymentSettlementLink.bank_transaction_id)
        .join(
            BankPaymentSettlement,
            BankPaymentSettlement.id == BankPaymentSettlementLink.settlement_id,
        )
        .where(BankPaymentSettlement.status == "open")
        .union(
            select(BankPaymentSettlement.source_bank_transaction_id).join(
                BankPaymentSettlementLink,
                BankPaymentSettlementLink.settlement_id == BankPaymentSettlement.id,
            )
        )
    )


def protect_payment_bank(session, bank_id, *, matching=False):
    mutation_lock(session)
    bank = session.get(BankTransaction, bank_id)
    if bank and bank.is_archived:
        raise HTTPException(409, "该未实付登记已作废保留，不能再次修改或匹配")
    group = group_for(session, bank_id)
    if group and (group.status == "completed" or linked_rows(session, group)):
        raise HTTPException(409, "该流水已进入实付核对，请先移除草稿关联；完成记录只读")
    link_group = session.scalar(
        select(BankPaymentSettlement)
        .join(
            BankPaymentSettlementLink,
            BankPaymentSettlementLink.settlement_id == BankPaymentSettlement.id,
        )
        .where(BankPaymentSettlementLink.bank_transaction_id == bank_id)
    )
    inherited_match = link_group and session.scalar(
        select(ExpenseBankMatch.id)
        .where(
            ExpenseBankMatch.bank_transaction_id == link_group.source_bank_transaction_id,
            ExpenseBankMatch.status == "confirmed",
        )
        .limit(1)
    )
    if link_group and (not matching or link_group.status == "open" or inherited_match):
        raise HTTPException(409, "该实付流水已被核对占用，不能修改、删除或重复关联")


def annotate_payment_status(session, banks):
    ids = [b.id for b in banks]
    if not ids:
        return
    states = dict(
        session.execute(
            select(BankPaymentSettlementLink.bank_transaction_id, BankPaymentSettlement.status)
            .join(
                BankPaymentSettlement,
                BankPaymentSettlement.id == BankPaymentSettlementLink.settlement_id,
            )
            .where(BankPaymentSettlementLink.bank_transaction_id.in_(ids))
        ).all()
    )
    states.update(
        dict(
            session.execute(
                select(
                    BankPaymentSettlement.source_bank_transaction_id, BankPaymentSettlement.status
                )
                .join(
                    BankPaymentSettlementLink,
                    BankPaymentSettlementLink.settlement_id == BankPaymentSettlement.id,
                )
                .where(BankPaymentSettlement.source_bank_transaction_id.in_(ids))
                .distinct()
            ).all()
        )
    )
    for bank in banks:
        bank.payment_settlement_status = states.get(bank.id)


def ensure_source_ready(session, source):
    if session.scalar(
        select(ExpenseBankMatch.id)
        .where(
            ExpenseBankMatch.bank_transaction_id == source.id,
            ExpenseBankMatch.status == "candidate",
        )
        .limit(1)
    ):
        raise HTTPException(409, "原登记有待确认的审批匹配，请先确认或解除后再核对实付")
    if session.scalar(
        select(RevenueBankMatch.id)
        .where(
            RevenueBankMatch.bank_transaction_id == source.id, RevenueBankMatch.status != "rejected"
        )
        .limit(1)
    ):
        raise HTTPException(409, "该登记存在收入匹配，不能进行支出实付核对")


def target_eligible(session, bank, source, *, group=None):
    if (
        bank.id == source.id
        or bank.store_id != source.store_id
        or bank.is_archived
        or bank.direction != "expense"
        or bank.payment_status != "paid"
        or bank.direct_posting_type
        or bank.special_type
        or Decimal(bank.matched_amount or 0) > 0
    ):
        return False
    if session.scalar(
        select(ExpenseBankMatch.id)
        .where(
            ExpenseBankMatch.bank_transaction_id == bank.id, ExpenseBankMatch.status != "rejected"
        )
        .limit(1)
    ):
        return False
    if session.scalar(
        select(RevenueBankMatch.id)
        .where(
            RevenueBankMatch.bank_transaction_id == bank.id, RevenueBankMatch.status != "rejected"
        )
        .limit(1)
    ):
        return False
    if group_for(session, bank.id):
        return False
    link = session.scalar(
        select(BankPaymentSettlementLink).where(
            BankPaymentSettlementLink.bank_transaction_id == bank.id
        )
    )
    return not link or (group is not None and link.settlement_id == group.id)


def detail_data(session, bank, group):
    links = linked_rows(session, group)
    total = sum((Decimal(row.amount) for _, row in links), Decimal("0"))
    return {
        "source": BankTransactionRead.model_validate(bank),
        "status": group.status if group else "open",
        "links": [
            {"id": link.id, "transaction": BankTransactionRead.model_validate(row)}
            for link, row in links
        ],
        "registered_amount": format(bank.amount, ".2f"),
        "actual_amount": format(total, ".2f"),
        "difference": format(total - bank.amount, ".2f"),
        "remark": group.remark if group else None,
        "completed_at": group.completed_at if group else None,
    }


@router.get("")
def list_settlements(
    store_id: str,
    status: str = "pending",
    page: int = 1,
    page_size: int = 12,
    session: Session = Depends(get_session),
    user: User = Depends(require_permission("reconciliation.view")),
):
    ensure_store_access(session, user, store_id)
    if status not in {"pending", "completed"}:
        raise HTTPException(422, "无效的核对状态")
    query = select(BankTransaction).where(
        BankTransaction.store_id == store_id,
        BankTransaction.direction == "expense",
        BankTransaction.payment_status == "unpaid",
        BankTransaction.direct_posting_type.is_(None),
        BankTransaction.is_archived.is_(status == "completed"),
    )
    if status == "completed":
        query = query.join(
            BankPaymentSettlement,
            BankPaymentSettlement.source_bank_transaction_id == BankTransaction.id,
        ).where(BankPaymentSettlement.status == "completed")
    sub = query.subquery()
    count, amount = session.execute(
        select(func.count(), func.coalesce(func.sum(sub.c.amount), 0)).select_from(sub)
    ).one()
    page, page_size = max(page, 1), min(max(page_size, 1), 100)
    real = aliased(BankTransaction)
    linked_total = session.scalar(
        select(func.sum(real.amount))
        .select_from(BankPaymentSettlementLink)
        .join(
            BankPaymentSettlement,
            BankPaymentSettlement.id == BankPaymentSettlementLink.settlement_id,
        )
        .join(real, real.id == BankPaymentSettlementLink.bank_transaction_id)
        .where(BankPaymentSettlement.source_bank_transaction_id.in_(select(sub.c.id)))
    ) or Decimal("0")
    banks = list(
        session.scalars(
            query.order_by(BankTransaction.occurred_at.desc(), BankTransaction.id)
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    )
    return ApiEnvelope(
        data={
            "items": [BankTransactionRead.model_validate(b) for b in banks],
            "total": count,
            "registered_total": str(amount),
            "linked_total": str(linked_total),
            "page": page,
            "page_size": page_size,
        }
    )


@router.get("/{source_id}")
def read_settlement(
    source_id: str,
    session: Session = Depends(get_session),
    user: User = Depends(require_permission("reconciliation.view")),
):
    bank, group = source_bank(session, user, source_id)
    return ApiEnvelope(data=detail_data(session, bank, group))


@router.get("/{source_id}/candidates")
def candidates(
    source_id: str,
    counterparty_name: str | None = None,
    session: Session = Depends(get_session),
    user: User = Depends(require_permission("reconciliation.view")),
):
    source, group = source_bank(session, user, source_id)
    if source.is_archived:
        return ApiEnvelope(data=[])
    # SQL removes occupied/processed records before ranking; no first-page-only recommendation.
    occupied = select(BankPaymentSettlementLink.bank_transaction_id)
    revenue_matched = select(RevenueBankMatch.bank_transaction_id).where(
        RevenueBankMatch.status != "rejected"
    )
    source_ids = select(BankPaymentSettlement.source_bank_transaction_id)
    matched = select(ExpenseBankMatch.bank_transaction_id).where(
        ExpenseBankMatch.status != "rejected"
    )
    query = select(BankTransaction).where(
        BankTransaction.store_id == source.store_id,
        BankTransaction.id != source.id,
        BankTransaction.direction == "expense",
        BankTransaction.payment_status == "paid",
        BankTransaction.is_archived.is_(False),
        BankTransaction.direct_posting_type.is_(None),
        BankTransaction.special_type.is_(None),
        BankTransaction.matched_amount == 0,
        BankTransaction.id.not_in(occupied),
        BankTransaction.id.not_in(matched),
        BankTransaction.id.not_in(revenue_matched),
        BankTransaction.id.not_in(source_ids),
    )
    if counterparty_name and counterparty_name.strip():
        query = query.where(
            BankTransaction.counterparty_name.contains(counterparty_name.strip(), autoescape=True)
        )
    closed = (
        select(Ledger.id)
        .where(
            Ledger.store_id == BankTransaction.store_id,
            Ledger.status == "closed",
            or_(
                Ledger.period == BankTransaction.ledger_period,
                Ledger.period == func.to_char(BankTransaction.occurred_at, "YYYY-MM"),
            ),
        )
        .exists()
    )
    banks = session.scalars(query.where(~closed)).all()
    result = []
    for bank in banks:
        days = abs((bank.occurred_at.date() - source.occurred_at.date()).days)
        score = (
            (60 if bank.amount == source.amount else 0)
            + (
                25
                if bank.counterparty_name and bank.counterparty_name == source.counterparty_name
                else 0
            )
            + max(0, 15 - min(days, 15))
        )
        result.append({"transaction": BankTransactionRead.model_validate(bank), "score": score})
    result.sort(key=lambda r: (-r["score"], r["transaction"].occurred_at, r["transaction"].id))
    return ApiEnvelope(data=result[:200])


@router.post("/{source_id}/links")
def add_links(
    source_id: str,
    payload: AddLinks,
    session: Session = Depends(get_session),
    user: User = Depends(require_permission("reconciliation.manage")),
):
    mutation_lock(session)
    source, group = source_bank(session, user, source_id, write=True)
    ensure_source_ready(session, source)
    ids = sorted(set(payload.bank_transaction_ids))
    banks = list(
        session.scalars(
            select(BankTransaction)
            .where(BankTransaction.id.in_(ids))
            .order_by(BankTransaction.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    )
    if len(banks) != len(ids):
        raise HTTPException(404, "选中的实付流水不存在")
    for bank in banks:
        if not target_eligible(session, bank, source):
            raise HTTPException(409, "只能关联同门店、未匹配且未被占用的已实付支出")
        check_open(session, bank)
    if not group:
        group = BankPaymentSettlement(source_bank_transaction_id=source.id)
        session.add(group)
        session.flush()
    for bank in banks:
        session.add(
            BankPaymentSettlementLink(
                settlement_id=group.id, bank_transaction_id=bank.id, created_by=user.id
            )
        )
    write_audit_log(
        session,
        actor=audit_actor(user),
        action="bank_payment_settlement.link",
        resource_type="bank_transaction",
        resource_id=source.id,
        summary=f"未实付核对增加{len(banks)}笔付款",
        metadata={"bank_ids": ids},
    )
    session.commit()
    return ApiEnvelope(data=detail_data(session, source, group))


@router.delete("/{source_id}/links/{link_id}")
def remove_link(
    source_id: str,
    link_id: str,
    session: Session = Depends(get_session),
    user: User = Depends(require_permission("reconciliation.manage")),
):
    mutation_lock(session)
    source, group = source_bank(session, user, source_id, write=True)
    link = session.get(BankPaymentSettlementLink, link_id)
    if not group or not link or link.settlement_id != group.id:
        raise HTTPException(404, "关联记录不存在")
    session.delete(link)
    session.flush()
    if not session.scalar(
        select(BankPaymentSettlementLink.id)
        .where(BankPaymentSettlementLink.settlement_id == group.id)
        .limit(1)
    ):
        session.delete(group)
        group = None
    write_audit_log(
        session,
        actor=audit_actor(user),
        action="bank_payment_settlement.unlink",
        resource_type="bank_transaction",
        resource_id=source.id,
        summary="移除未实付核对关联",
        metadata={"bank_id": link.bank_transaction_id},
    )
    session.commit()
    return ApiEnvelope(data=detail_data(session, source, group))


@router.post("/{source_id}/complete")
def complete(
    source_id: str,
    payload: CompleteSettlement,
    session: Session = Depends(get_session),
    user: User = Depends(require_permission("reconciliation.manage")),
):
    mutation_lock(session)
    source, group = source_bank(session, user, source_id, write=True)
    ensure_source_ready(session, source)
    links = linked_rows(session, group)
    if not links:
        raise HTTPException(409, "请至少关联一笔实际付款")
    banks = list(
        session.scalars(
            select(BankTransaction)
            .where(BankTransaction.id.in_([b.id for _, b in links]))
            .order_by(BankTransaction.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    )
    for bank in banks:
        if not target_eligible(session, bank, source, group=group):
            raise HTTPException(409, "关联流水已变化，请重新核对")
        check_open(session, bank)
    total = sum((b.amount for b in banks), Decimal("0"))
    difference = total - source.amount
    if difference and (not payload.confirm_difference or not payload.remark.strip()):
        raise HTTPException(422, "实付金额与登记金额不一致，请二次确认并填写差额原因")
    matches = list(
        session.scalars(
            select(ExpenseBankMatch)
            .where(
                ExpenseBankMatch.bank_transaction_id == source.id,
                ExpenseBankMatch.status == "confirmed",
            )
            .with_for_update()
        )
    )
    for match in matches:
        if session.scalar(
            select(Ledger.id)
            .where(
                Ledger.store_id == source.store_id,
                Ledger.period == match.accounting_period,
                Ledger.status == "closed",
            )
            .limit(1)
        ):
            raise HTTPException(409, "原审批入账月份已封账，请先解封")
    group.registered_amount, group.actual_amount = source.amount, total
    group.status, group.remark = "completed", payload.remark.strip() or None
    group.completed_by, group.completed_at = user.id, utc_now()
    group.source_snapshot_json = json.dumps(
        {
            "source_id": source.id,
            "amount": str(source.amount),
            "matches": [
                {"id": m.id, "amount": str(m.amount), "accounting_period": m.accounting_period}
                for m in matches
            ],
        },
        ensure_ascii=False,
    )
    source.is_archived = True
    for bank in banks:
        if matches:
            bank.matched_amount = bank.amount
        if source.special_type:
            bank.special_type = source.special_type
    from app.modules.matching.router import refresh_expense_payment_status
    from app.models import ExpenseItem

    for match in matches:
        match.bank_occurred = True
        item = session.get(ExpenseItem, match.expense_item_id)
        if item is not None:
            refresh_expense_payment_status(session, item)
    write_audit_log(
        session,
        actor=audit_actor(user),
        action="bank_payment_settlement.complete",
        resource_type="bank_transaction",
        resource_id=source.id,
        summary=f"未实付核对完成：登记{source.amount}，实付{total}，差额{difference}",
        metadata={
            "registered": str(source.amount),
            "actual": str(total),
            "difference": str(difference),
            "remark": group.remark,
            "bank_ids": [b.id for b in banks],
        },
    )
    session.commit()
    return ApiEnvelope(data=detail_data(session, source, group))
