import os
from sqlalchemy import create_engine, text

url = os.environ.get("DATABASE_URL", "postgresql+psycopg://finhub:finhub@localhost:5432/finhub")
engine = create_engine(url)
STORE = "37d50cafe90c47ddab2728a6cec1d21d"

with engine.connect() as conn:
    print("== revenue_records by period/channel ==")
    rows = conn.execute(text("""
        select ledger_period, channel, count(*) c, sum(net_amount) net,
               min(revenue_date) d0, max(revenue_date) d1
        from revenue_records where store_id=:s
        group by 1,2 order by 1 desc, 2
    """), {"s": STORE}).all()
    for r in rows:
        print(r)

    print("\n== active revenue channels ==")
    for r in conn.execute(text("select name, status, sort_order from revenue_channels order by sort_order")).all():
        print(r)

    print("\n== revenue_bank_matches for store ==")
    rows = conn.execute(text("""
        select m.id, m.channel, m.revenue_start_date, m.revenue_end_date, m.amount,
               m.status, m.accounting_period,
               (select count(*) from revenue_bank_match_records r where r.revenue_bank_match_id=m.id) nrec
        from revenue_bank_matches m
        join bank_transactions b on b.id = m.bank_transaction_id
        where b.store_id=:s order by m.created_at desc limit 30
    """), {"s": STORE}).all()
    for r in rows:
        print(r)

    print("\n== income bank transactions (unmatched remaining) ==")
    rows = conn.execute(text("""
        select id, occurred_at::date, amount, matched_amount, ledger_period
        from bank_transactions
        where store_id=:s and direction='income'
        order by occurred_at desc limit 20
    """), {"s": STORE}).all()
    for r in rows:
        print(r)
