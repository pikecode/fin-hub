import json
from datetime import datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.crypto import encrypt_secret
from app.core.database import SessionLocal
from app.core.security import hash_password
from app.models import (
    ApprovalTemplate,
    BankTransaction,
    DingTalkConfig,
    ExpenseBankMatch,
    ExpenseCategory,
    ExpenseItem,
    ExpensePaymentStatus,
    Ledger,
    LedgerStatus,
    MatchStatus,
    RevenueChannel,
    RevenueRecord,
    ShareholderAccessGrant,
    Store,
    Supplier,
    TemplateFieldMapping,
    User,
    UserRole,
    UserStatus,
)


def get_or_create_store(session: Session, name: str, **values: str) -> Store:
    store = session.scalar(select(Store).where(Store.name == name))
    if store is not None:
        return store
    store = Store(name=name, **values)
    session.add(store)
    session.flush()
    return store


def get_or_create_ledger(session: Session, store_id: str, period: str, status: str) -> Ledger:
    ledger = session.scalar(select(Ledger).where(Ledger.store_id == store_id, Ledger.period == period))
    if ledger is not None:
        return ledger
    ledger = Ledger(store_id=store_id, period=period, status=status)
    session.add(ledger)
    session.flush()
    return ledger


def seed_expense_item(
    session: Session,
    store_id: str,
    period: str,
    description: str,
    amount: str,
    category_l1: str | None,
    supplier_name: str | None,
) -> ExpenseItem:
    item = session.scalar(
        select(ExpenseItem).where(
            ExpenseItem.store_id == store_id,
            ExpenseItem.ledger_period == period,
            ExpenseItem.description == description,
        )
    )
    if item is not None:
        return item
    item = ExpenseItem(
        store_id=store_id,
        ledger_period=period,
        expense_date=datetime(2026, 8, 12),
        description=description,
        amount=Decimal(amount),
        category_l1=category_l1,
        category_l2=None,
        supplier_name=supplier_name,
        payee_account="6222 **** 8899",
        payment_status=ExpensePaymentStatus.UNPAID.value,
        source="seed",
    )
    session.add(item)
    session.flush()
    return item


def seed_bank_transaction(
    session: Session,
    store_id: str,
    period: str,
    serial_no: str,
    amount: str,
    counterparty_name: str,
    direction: str = "expense",
) -> BankTransaction:
    transaction = session.scalar(
        select(BankTransaction).where(BankTransaction.bank_serial_no == serial_no)
    )
    if transaction is not None:
        return transaction
    transaction = BankTransaction(
        store_id=store_id,
        ledger_period=period,
        occurred_at=datetime(2026, 8, 13, 10, 30),
        direction=direction,
        amount=Decimal(amount),
        counterparty_name=counterparty_name,
        counterparty_account="6222 **** 8899",
        summary="开发样例流水",
        bank_serial_no=serial_no,
    )
    session.add(transaction)
    session.flush()
    return transaction


def seed_revenue_record(
    session: Session,
    store_id: str,
    period: str,
    revenue_date: datetime,
    channel: str,
    gross_amount: str,
    net_amount: str,
    fee_amount: str,
) -> RevenueRecord:
    record = session.scalar(
        select(RevenueRecord).where(
            RevenueRecord.store_id == store_id,
            RevenueRecord.ledger_period == period,
            RevenueRecord.revenue_date == revenue_date.date(),
            RevenueRecord.channel == channel,
        )
    )
    if record is not None:
        return record
    record = RevenueRecord(
        store_id=store_id,
        ledger_period=period,
        revenue_date=revenue_date.date(),
        channel=channel,
        gross_amount=Decimal(gross_amount),
        net_amount=Decimal(net_amount),
        fee_amount=Decimal(fee_amount),
        remark="开发样例收入",
    )
    session.add(record)
    session.flush()
    return record


def seed_revenue_channel(session: Session, name: str, sort_order: int, requires_bank_match: bool = True) -> RevenueChannel:
    channel = session.scalar(select(RevenueChannel).where(RevenueChannel.name == name))
    if channel is not None:
        return channel
    channel = RevenueChannel(name=name, sort_order=sort_order, requires_bank_match=requires_bank_match)
    session.add(channel)
    session.flush()
    return channel


def seed_match(
    session: Session,
    expense_item_id: str,
    bank_transaction_id: str,
    amount: str,
    status: str,
) -> None:
    match = session.scalar(
        select(ExpenseBankMatch).where(
            ExpenseBankMatch.expense_item_id == expense_item_id,
            ExpenseBankMatch.bank_transaction_id == bank_transaction_id,
        )
    )
    if match is not None:
        return
    match = ExpenseBankMatch(
        expense_item_id=expense_item_id,
        bank_transaction_id=bank_transaction_id,
        amount=Decimal(amount),
        status=status,
        confidence=Decimal("92.00"),
        reason="金额和收款方一致",
        confirmed_by="seed" if status == MatchStatus.CONFIRMED.value else None,
        confirmed_at=datetime(2026, 8, 14, 9, 0) if status == MatchStatus.CONFIRMED.value else None,
    )
    session.add(match)


def seed_dingtalk_config(session: Session) -> None:
    config = session.scalar(select(DingTalkConfig).order_by(DingTalkConfig.created_at.asc()))
    if config is not None:
        if config.app_secret_encrypted and config.app_secret_encrypted.startswith("configured:"):
            config.app_secret_encrypted = encrypt_secret("seed-app-secret")
            config.status = "configured"
        return
    session.add(
        DingTalkConfig(
            corp_id="seed-corp-id",
            app_key="seed-app-key",
            app_secret_encrypted=encrypt_secret("seed-app-secret"),
            admin_user_id="seed-admin-user",
            drive_union_id="seed-drive-union",
            status="configured",
        )
    )


def seed_admin_user(session: Session) -> None:
    user = session.scalar(select(User).where(User.username == "admin"))
    if user is not None:
        return
    session.add(
        User(
            username="admin",
            display_name="系统管理员",
            password_hash=hash_password("admin123456"),
            role=UserRole.ADMIN.value,
            status=UserStatus.ACTIVE.value,
        )
    )


def get_or_create_category(
    session: Session,
    name: str,
    parent_id: str | None = None,
    sort_order: int = 0,
) -> ExpenseCategory:
    category = session.scalar(
        select(ExpenseCategory).where(
            ExpenseCategory.name == name,
            ExpenseCategory.parent_id == parent_id,
        )
    )
    if category is not None:
        return category
    category = ExpenseCategory(name=name, parent_id=parent_id, sort_order=sort_order)
    session.add(category)
    session.flush()
    return category


def get_or_create_supplier(session: Session, name: str, **values: str) -> Supplier:
    supplier = session.scalar(select(Supplier).where(Supplier.name == name))
    if supplier is not None:
        return supplier
    supplier = Supplier(name=name, **values)
    session.add(supplier)
    session.flush()
    return supplier


def seed_master_data(session: Session) -> None:
    food_cost = get_or_create_category(session, "食材成本", sort_order=5)
    get_or_create_category(session, "食材采购", parent_id=food_cost.id, sort_order=6)
    rent = get_or_create_category(session, "房租水电", sort_order=10)
    get_or_create_category(session, "水电费", parent_id=rent.id, sort_order=11)
    get_or_create_category(session, "房租", parent_id=rent.id, sort_order=12)
    marketing = get_or_create_category(session, "营销物料", sort_order=20)
    get_or_create_category(session, "广告制作", parent_id=marketing.id, sort_order=21)
    operations = get_or_create_category(session, "运营杂费", sort_order=30)
    get_or_create_category(session, "维修维护", parent_id=operations.id, sort_order=31)

    get_or_create_supplier(
        session,
        "供电公司",
        bank_account="6222 **** 8899",
        contact_name="客服",
        phone="95598",
        remark="水电费样例供应商",
    )
    get_or_create_supplier(
        session,
        "广告公司",
        bank_account="6222 **** 6688",
        contact_name="物料对接人",
        phone="13600000000",
        remark="广告物料样例供应商",
    )


def seed_shareholder_grant(session: Session, store_ids: list[str]) -> None:
    grant = session.scalar(select(ShareholderAccessGrant).where(ShareholderAccessGrant.name == "开发股东授权"))
    if grant is not None:
        return
    session.add(
        ShareholderAccessGrant(
            name="开发股东授权",
            access_code_hash=hash_password("share123456"),
            store_ids_json=json.dumps(store_ids, ensure_ascii=False),
        )
    )


def seed_dingtalk_templates(session: Session) -> None:
    template = session.scalar(
        select(ApprovalTemplate).where(ApprovalTemplate.process_code == "seed-expense-approval")
    )
    if template is None:
        template = ApprovalTemplate(
            process_code="seed-expense-approval",
            name="门店费用报销",
            is_enabled=True,
            mapping_status="mapped",
            last_sync_at=datetime(2026, 8, 29, 9, 0),
        )
        session.add(template)
        session.flush()

    mappings = [
        ("store", "门店", "TextField", True, 10),
        ("expense_date", "支出日期", "DateField", True, 20),
        ("amount", "金额", "MoneyField", True, 30),
        ("description", "支出详情", "TextField", True, 40),
        ("category_l1", "一级分类", "TextField", False, 50),
        ("supplier_name", "供应商", "TextField", False, 60),
        ("payee_account", "收款账号", "TextField", False, 70),
    ]
    for standard_field, source_field_name, field_type, is_required, sort_order in mappings:
        exists = session.scalar(
            select(TemplateFieldMapping).where(
                TemplateFieldMapping.template_id == template.id,
                TemplateFieldMapping.standard_field == standard_field,
            )
        )
        if exists is not None:
            continue
        session.add(
            TemplateFieldMapping(
                template_id=template.id,
                standard_field=standard_field,
                source_field_id=f"seed-{standard_field}",
                source_field_name=source_field_name,
                source_path=source_field_name,
                field_type=field_type,
                is_required=is_required,
                sort_order=sort_order,
            )
        )


def run() -> None:
    with SessionLocal() as session:
        seed_admin_user(session)
        seed_master_data(session)
        foshan = get_or_create_store(
            session,
            "蘑说佛山南海万达店",
            dingtalk_dept_id="seed-dept-foshan",
            contact_person="胡可明",
            phone="13800000000",
            address="佛山市南海区",
        )
        guangzhou = get_or_create_store(
            session,
            "蘑说广州天河店",
            dingtalk_dept_id="seed-dept-guangzhou",
            contact_person="财务同事",
            phone="13900000000",
            address="广州市天河区",
        )
        seed_shareholder_grant(session, [foshan.id, guangzhou.id])

        get_or_create_ledger(session, foshan.id, "2026-08", LedgerStatus.OPEN.value)
        get_or_create_ledger(session, guangzhou.id, "2026-08", LedgerStatus.CLOSED.value)

        seed_revenue_channel(session, "美团团购", 10)
        seed_revenue_channel(session, "美团点评买单", 20)
        seed_revenue_channel(session, "抖音团购", 30)
        seed_revenue_channel(session, "扫码收款", 40)
        seed_revenue_channel(session, "商场代金券", 50, requires_bank_match=False)
        seed_revenue_channel(session, "现金收款", 60, requires_bank_match=False)
        seed_revenue_channel(session, "淘宝团购", 70)

        seed_revenue_record(
            session, foshan.id, "2026-08", datetime(2026, 8, 12), "美团团购", "56820.00", "55210.00", "1610.00"
        )
        seed_revenue_record(
            session, foshan.id, "2026-08", datetime(2026, 8, 12), "抖音团购", "32640.00", "31820.00", "820.00"
        )
        seed_revenue_record(
            session, guangzhou.id, "2026-08", datetime(2026, 8, 12), "扫码收款", "42100.00", "42100.00", "0.00"
        )

        item_1 = seed_expense_item(session, foshan.id, "2026-08", "门店水电费", "1280.00", "房租水电", "供电公司")
        item_2 = seed_expense_item(session, foshan.id, "2026-08", "广告物料制作", "860.00", None, None)
        tx_1 = seed_bank_transaction(session, foshan.id, "2026-08", "SEED-BANK-0001", "1280.00", "供电公司")
        seed_bank_transaction(session, foshan.id, "2026-08", "SEED-BANK-0002", "860.00", "广告公司")
        seed_bank_transaction(
            session,
            foshan.id,
            "2026-08",
            "SEED-BANK-0003",
            "182340.50",
            "门店营业款",
            "income",
        )
        seed_match(session, item_1.id, tx_1.id, "1280.00", MatchStatus.CONFIRMED.value)
        item_1.payment_status = ExpensePaymentStatus.PAID.value
        tx_1.matched_amount = Decimal("1280.00")
        seed_match(session, item_2.id, tx_1.id, "860.00", MatchStatus.REJECTED.value)

        seed_dingtalk_config(session)
        seed_dingtalk_templates(session)
        session.commit()


if __name__ == "__main__":
    run()
