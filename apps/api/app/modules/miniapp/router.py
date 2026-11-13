"""Read-only mobile facade using the same store-scoped financial services as web."""

# ruff: noqa: B008
import base64
import hashlib
import hmac
import json
import time
from datetime import date, datetime
from datetime import time as day_time
from decimal import Decimal

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.core.security import _sign, hash_password, verify_password
from app.models import Ledger, RevenueRecord, Store, User, utc_now
from app.modules.auth.permissions import effective_store_ids, ensure_permission, ensure_store_access
from app.modules.auth.router import to_current_user
from app.schemas import ApiEnvelope, ChangePasswordRequest, LoginRequest

router = APIRouter(prefix="/miniapp", tags=["miniapp"])


def password_stamp(user):
    return hashlib.sha256(user.password_hash.encode()).hexdigest()


def make_token(user):
    raw = json.dumps(
        {
            "typ": "miniapp",
            "sub": user.id,
            "pwd": password_stamp(user),
            "exp": int(time.time()) + 43200,
        }
    )
    encoded = base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")
    return encoded + "." + _sign(encoded)


def mobile_user(
    authorization: str | None = Header(default=None), session: Session = Depends(get_session)
):
    try:
        if not authorization or not authorization.startswith("Bearer "):
            raise ValueError
        encoded, signature = authorization[7:].split(".", 1)
        if not hmac.compare_digest(signature, _sign(encoded)):
            raise ValueError
        payload = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        if payload.get("typ") != "miniapp" or payload.get("exp", 0) <= time.time():
            raise ValueError
        user = session.get(User, payload.get("sub"))
        if not user or user.status != "active" or payload.get("pwd") != password_stamp(user):
            raise ValueError
    except (ValueError, TypeError, KeyError):
        raise HTTPException(401, "登录已失效，请重新登录") from None
    ensure_permission(session, user, "reports.view")
    return user


def scope(session, user, store_id):
    ensure_store_access(session, user, store_id)
    if not session.get(Store, store_id):
        raise HTTPException(404, "门店不存在")


def readable_period(session, user, store_id, period):
    scope(session, user, store_id)
    ledger = session.scalar(
        select(Ledger).where(Ledger.store_id == store_id, Ledger.period == period)
    )
    if not ledger:
        raise HTTPException(404, "该月份尚未创建账期")
    return ledger


@router.post("/login")
def login(payload: LoginRequest, session: Session = Depends(get_session)):
    user = session.scalar(select(User).where(User.username == payload.username))
    if (
        not user
        or user.status != "active"
        or not verify_password(payload.password, user.password_hash)
    ):
        raise HTTPException(401, "用户名或密码错误")
    ensure_permission(session, user, "reports.view")
    user.last_login_at = utc_now()
    session.commit()
    return ApiEnvelope(data={"token": make_token(user), "user": to_current_user(session, user)})


@router.get("/me")
def me(session: Session = Depends(get_session), user: User = Depends(mobile_user)):
    return ApiEnvelope(data=to_current_user(session, user))


@router.post("/change-password")
def password(
    payload: ChangePasswordRequest,
    session: Session = Depends(get_session),
    user: User = Depends(mobile_user),
):
    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(400, "原密码错误")
    if verify_password(payload.new_password, user.password_hash):
        raise HTTPException(422, "新密码不能与原密码相同")
    user.password_hash = hash_password(payload.new_password)
    session.commit()
    return ApiEnvelope(data={"ok": True})


@router.get("/stores")
def stores(session: Session = Depends(get_session), user: User = Depends(mobile_user)):
    rows = session.scalars(
        select(Store)
        .where(Store.id.in_(effective_store_ids(session, user)), Store.status == "active")
        .order_by(Store.name)
    ).all()
    return ApiEnvelope(data=[{"id": s.id, "name": s.name} for s in rows])


@router.get("/periods")
def periods(
    store_id: str, session: Session = Depends(get_session), user: User = Depends(mobile_user)
):
    scope(session, user, store_id)
    return ApiEnvelope(
        data=list(
            session.scalars(
                select(Ledger.period)
                .where(Ledger.store_id == store_id)
                .order_by(Ledger.period.desc())
            )
        )
    )


@router.get("/report")
def report(
    store_id: str,
    period: str = Query(pattern=r"^\d{4}-(0[1-9]|1[0-2])$"),
    session: Session = Depends(get_session),
    user: User = Depends(mobile_user),
):
    from app.modules.reports.financial import supplement
    from app.modules.store_ledgers.router import read_store_financial_report
    from app.modules.expense.router import list_major_expense_vouchers

    readable_period(session, user, store_id, period)
    return ApiEnvelope(
        data={
            "report": read_store_financial_report(store_id, period, session, user).data,
            "supplement": supplement(store_id, period, session, user).data,
            "major_vouchers": list_major_expense_vouchers(store_id, period, session, user).data,
            "retrieved_at": utc_now().isoformat(),
            "contract_version": "pc-parity-1",
        }
    )


@router.get("/revenue")
def revenue(
    store_id: str,
    period: str = Query(pattern=r"^\d{4}-(0[1-9]|1[0-2])$"),
    page: int = Query(1, ge=1),
    session: Session = Depends(get_session),
    user: User = Depends(mobile_user),
):
    from app.schemas import RevenueRecordRead

    readable_period(session, user, store_id, period)
    rows = list(
        session.scalars(
            select(RevenueRecord).where(
                RevenueRecord.store_id == store_id,
                RevenueRecord.revenue_date >= date.fromisoformat(period + "-01"),
                RevenueRecord.revenue_date
                < date(int(period[:4]) + (period[5:] == "12"), int(period[5:]) % 12 + 1, 1),
            )
        )
    )
    channels = {}
    for r in rows:
        b = channels.setdefault(
            r.channel,
            {"channel": r.channel, "gross": Decimal(0), "net": Decimal(0), "fee": Decimal(0)},
        )
        b["gross"] += r.gross_amount
        b["net"] += r.net_amount
        b["fee"] += r.fee_amount
    return ApiEnvelope(
        data={
            "channels": list(channels.values()),
            "items": [
                RevenueRecordRead.model_validate(r)
                for r in sorted(rows, key=lambda r: (r.revenue_date, r.id), reverse=True)[
                    (page - 1) * 30 : page * 30
                ]
            ],
            "total": len(rows),
        }
    )


@router.get("/bank")
def bank(
    store_id: str,
    start: date | None = None,
    end: date | None = None,
    match_status: str | None = Query(None, pattern="^(matched|unmatched)$"),
    page: int = Query(1, ge=1),
    session: Session = Depends(get_session),
    user: User = Depends(mobile_user),
):
    from app.modules.bank.router import list_bank_transactions
    from app.modules.bank_balance.router import calculate_bank_balance
    from app.schemas import BankTransactionRead, Page

    scope(session, user, store_id)
    if start and end and start > end:
        raise HTTPException(422, "开始日期不能晚于结束日期")
    result = list_bank_transactions(
        store_id=store_id,
        match_status=match_status,
        occurred_from=datetime.combine(start, day_time.min) if start else None,
        occurred_to=datetime.combine(end, day_time.max) if end else None,
        page=page,
        page_size=30,
        session=session,
        current_user=user,
    )
    return ApiEnvelope(
        data={
            # Direct calls bypass the web route's response_model conversion.
            "list": Page[BankTransactionRead](
                items=[BankTransactionRead.model_validate(row) for row in result.data.items],
                total=result.data.total, page=page, page_size=30,
            ),
            "balance": calculate_bank_balance(session, store_id),
        }
    )


@router.get("/bank/{transaction_id}")
def bank_detail(
    transaction_id: str, session: Session = Depends(get_session), user: User = Depends(mobile_user)
):
    from app.modules.bank.router import bank_transaction_business_detail

    return bank_transaction_business_detail(transaction_id, session, user)


@router.get("/dividend")
def dividend(
    store_id: str,
    period: str = Query(pattern=r"^\d{4}-(0[1-9]|1[0-2])$"),
    session: Session = Depends(get_session),
    user: User = Depends(mobile_user),
):
    from app.modules.dividend.opening import configured_history, opening_read
    from app.modules.dividend.router import history_rows

    readable_period(session, user, store_id, period)
    store = session.get(Store, store_id)
    opening = opening_read(session, store_id)
    history = (
        configured_history(session, store_id, period)
        if opening.configured
        else history_rows(session, store, period, create_missing=False)
    )
    visible = set(
        session.scalars(
            select(Ledger.period).where(
                Ledger.store_id == store_id, Ledger.period <= period
            )
        )
    )
    from app.modules.reports.financial import supplement

    return ApiEnvelope(
        data={"opening": opening, "history": [r for r in history if r.period in visible],
              "supplement": supplement(store_id, period, session, user).data}
    )


@router.get("/preopening")
def preopening(
    store_id: str, session: Session = Depends(get_session), user: User = Depends(mobile_user)
):
    from app.modules.preopening.router import workspace

    scope(session, user, store_id)
    data = workspace(store_id, session, user).data
    return ApiEnvelope(data={k: data[k] for k in ("store_name", "status", "total", "details")})


@router.get("/attachments/{attachment_id}")
def attachment(
    attachment_id: str, session: Session = Depends(get_session), user: User = Depends(mobile_user)
):
    from app.models import Attachment
    from app.modules.attachments.router import download_attachment, resource_access

    row = session.get(Attachment, attachment_id)
    if not row or row.resource_type not in {"expense_item", "loan_event"}:
        raise HTTPException(404, "凭证不存在")
    resource_access(session, user, row.resource_type, row.resource_id)
    if row.download_status != "stored" and row.source == "dingtalk":
        from fastapi.responses import Response

        from app.modules.attachments.router import download_url_content, get_attachment_access_url

        url = get_attachment_access_url(attachment_id, session, user).data.url
        content, content_type = download_url_content(url)
        return Response(
            content, media_type=content_type or row.content_type or "application/octet-stream"
        )
    return download_attachment(attachment_id, session, user)


@router.get("/expenses")
def expenses(
    store_id: str,
    period: str = Query(pattern=r"^\d{4}-(0[1-9]|1[0-2])$"),
    category: str | None = None,
    page: int = Query(1, ge=1),
    session: Session = Depends(get_session),
    user: User = Depends(mobile_user),
):
    from app.models import Attachment
    from app.modules.reports.router import read_financial_analytics_details
    from app.schemas import AttachmentRead

    readable_period(session, user, store_id, period)
    l1, _, l2 = (category or "").partition(" / ")
    data = read_financial_analytics_details(detail_type="report_expense", store_id=store_id,
        period_start=period, period_end=period, category_l1=l1 or None, category_l2=l2 or None,
        session=session, shareholder_grant=None, current_user=user).data
    rows = data.expense_items
    result = []
    for item in rows[(page - 1) * 30 : page * 30]:
        attachments = session.scalars(select(Attachment).where(
            Attachment.resource_type == "expense_item", Attachment.resource_id == item.id)).all()
        result.append({"id": item.id, "date": item.expense_date, "description": item.description,
            "category_l1": item.category_l1, "category_l2": item.category_l2,
            "amount": item.amount, "source": item.source, "source_document_id": item.source_document_id,
            "attachments": [AttachmentRead.model_validate(a) for a in attachments]})
    return ApiEnvelope(data={"items": result, "total": len(rows),
        "total_amount": str(sum((Decimal(i.amount) for i in rows), Decimal(0)))})


@router.get("/record-attachments")
def record_attachments(resource_type: str = Query(pattern="^(expense_item|loan_event)$"),
    resource_id: str = Query(min_length=1), session: Session = Depends(get_session),
    user: User = Depends(mobile_user)):
    from app.models import Attachment
    from app.modules.attachments.router import resource_access
    from app.schemas import AttachmentRead
    resource_access(session, user, resource_type, resource_id)
    rows = session.scalars(select(Attachment).where(Attachment.resource_type == resource_type,
        Attachment.resource_id == resource_id).order_by(Attachment.created_at)).all()
    return ApiEnvelope(data=[AttachmentRead.model_validate(row) for row in rows])


@router.get("/report-special")
def report_special(store_id: str, period: str = Query(pattern=r"^\d{4}-(0[1-9]|1[0-2])$"),
    page: int = Query(1, ge=1), session: Session = Depends(get_session), user: User = Depends(mobile_user)):
    from app.modules.reports.financial import appendix
    readable_period(session, user, store_id, period)
    data = appendix(store_id, period, session, user).data
    rows = [r for r in data["rows"] if r["transaction"].get("special_type") or r["transaction"].get("direct_posting_type")]
    return ApiEnvelope(data={"items": rows[(page-1)*30:page*30], "total": len(rows)})
