from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.models import (
    ApprovalInstance,
    ApprovalTemplate,
    BankTransaction,
    ExpenseBankMatch,
    ExpenseItem,
    PreopeningStore,
)


def lock_store(session: Session, store_id: str) -> PreopeningStore:
    session.execute(
        insert(PreopeningStore).values(store_id=store_id, status="open").on_conflict_do_nothing()
    )
    return session.scalar(
        select(PreopeningStore).where(PreopeningStore.store_id == store_id).with_for_update()
    )


def ensure_open(state: PreopeningStore):
    if state.status == "closed":
        raise HTTPException(409, "筹建报表已封账，不能修改")


def ensure_operating(session: Session, expense: ExpenseItem, bank: BankTransaction):
    if expense.approval_instance_id:
        session.scalar(
            select(ApprovalInstance)
            .where(ApprovalInstance.id == expense.approval_instance_id)
            .with_for_update()
        )
    session.scalar(select(BankTransaction).where(BankTransaction.id == bank.id).with_for_update())
    session.refresh(expense)
    if expense.expense_scope != "operating":
        raise HTTPException(409, "该审批单属于筹建费用，请在筹建费用中对账")
    if session.scalar(
        select(ExpenseBankMatch.id).where(
            ExpenseBankMatch.bank_transaction_id == bank.id,
            ExpenseBankMatch.expense_scope == "preopening",
            ExpenseBankMatch.status.in_(["candidate", "confirmed"]),
        )
    ):
        raise HTTPException(409, "该流水已被筹建对账占用")


def change_template_scope(session: Session, template: ApprovalTemplate, enabled: bool):
    session.scalar(
        select(ApprovalTemplate).where(ApprovalTemplate.id == template.id).with_for_update()
    )
    store_ids = list(
        session.scalars(
            select(ApprovalInstance.store_id)
            .where(ApprovalInstance.template_id == template.id)
            .distinct()
        )
    )
    states = session.scalars(
        select(PreopeningStore)
        .where(PreopeningStore.store_id.in_([id for id in store_ids if id]))
        .order_by(PreopeningStore.store_id)
        .with_for_update()
    ).all()
    if any(state.status == "closed" for state in states):
        raise HTTPException(409, "该模板包含已封账门店的单据，不能修改费用归属")
    approvals = list(
        session.scalars(
            select(ApprovalInstance)
            .where(ApprovalInstance.template_id == template.id)
            .order_by(ApprovalInstance.id)
            .with_for_update()
        )
    )
    ids = [a.id for a in approvals]
    expenses = list(
        session.scalars(select(ExpenseItem).where(ExpenseItem.approval_instance_id.in_(ids)))
    )
    if session.scalar(
        select(ExpenseBankMatch.id).where(
            ExpenseBankMatch.expense_item_id.in_([e.id for e in expenses]),
            ExpenseBankMatch.status.in_(["candidate", "confirmed"]),
        )
    ):
        raise HTTPException(409, "该模板存在已匹配或待确认的审批单，请先撤销对账再修改费用归属")
    if session.scalar(
        select(PreopeningStore.store_id).where(
            PreopeningStore.store_id.in_([e.store_id for e in expenses]),
            PreopeningStore.status == "closed",
        )
    ):
        raise HTTPException(409, "该模板包含已封账门店的单据，不能修改费用归属")
    scope = "preopening" if enabled else "operating"
    for a in approvals:
        a.expense_scope = scope
    for e in expenses:
        e.expense_scope = scope
        e.category_l1 = e.category_l2 = None
        e.preopening_category_id = e.preopening_category_l1 = e.preopening_category_l2 = None


def protect_bank(session: Session, bank_id: str):
    store_id = session.scalar(select(BankTransaction.store_id).where(BankTransaction.id == bank_id))
    state = (
        session.scalar(
            select(PreopeningStore).where(PreopeningStore.store_id == store_id).with_for_update()
        )
        if store_id
        else None
    )
    if (
        state
        and state.status == "closed"
        and session.scalar(
            select(ExpenseBankMatch.id).where(
                ExpenseBankMatch.bank_transaction_id == bank_id,
                ExpenseBankMatch.expense_scope == "preopening",
                ExpenseBankMatch.status == "confirmed",
            )
        )
    ):
        raise HTTPException(409, "该流水关联已封账筹建报表，不能修改或删除")
