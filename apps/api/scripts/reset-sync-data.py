#!/usr/bin/env python3
"""Rebuild DingTalk approval-derived data.

Default scope clears DingTalk approval-derived data while preserving source
data such as departments, approval templates, stores, and configuration.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Iterable

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection
from sqlalchemy.engine.url import make_url

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.core.config import settings  # noqa: E402


DINGTALK_SYNC_JOB_TYPES = (
    "dingtalk_department_pull",
    "dingtalk_department_store_sync",
    "dingtalk_template_sync",
    "dingtalk_approval_sync",
    "dingtalk_store_approval_sync",
    "dingtalk_auto_sync",
)
DINGTALK_SYNC_JOB_TYPE_SQL = ",".join(repr(item) for item in DINGTALK_SYNC_JOB_TYPES)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Rebuild DingTalk approval-derived data for fin-hub.",
    )
    parser.add_argument(
        "--scope",
        choices=("approval-rebuild", "dingtalk-sync", "all-test-data"),
        default="approval-rebuild",
        help=(
            "approval-rebuild clears approval-derived data only. "
            "dingtalk-sync keeps the legacy reset scope. "
            "all-test-data also clears bank/revenue/ledger business test data."
        ),
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Actually delete data. Without this flag the script runs a rollback dry-run.",
    )
    parser.add_argument(
        "--database-url",
        default=settings.database_url,
        help="Override DATABASE_URL. Defaults to the app DATABASE_URL setting.",
    )
    parser.add_argument(
        "--store-id",
        default=None,
        help="Optional store id to scope DingTalk reset to a single store.",
    )
    parser.add_argument(
        "--ledger-period",
        default=None,
        help="Optional ledger period to scope DingTalk reset to a single period.",
    )
    parser.add_argument(
        "--approval-no",
        default=None,
        help="Optional approval number to scope DingTalk reset to a single approval.",
    )
    parser.add_argument(
        "--yes-i-know-this-deletes-data",
        action="store_true",
        help="Required with --execute.",
    )
    return parser.parse_args()


def scalar_int(conn: Connection, sql: str) -> int:
    return int(conn.scalar(text(sql)) or 0)


def count_tables(conn: Connection, tables: Iterable[str]) -> dict[str, int]:
    return {table: scalar_int(conn, f"SELECT count(*) FROM {table}") for table in tables}


def create_dingtalk_temp_tables(
    conn: Connection,
    *,
    store_id: str | None = None,
    ledger_period: str | None = None,
    approval_no: str | None = None,
) -> None:
    conn.execute(text("DROP TABLE IF EXISTS _reset_dingtalk_expense_ids"))
    conn.execute(text("DROP TABLE IF EXISTS _reset_dingtalk_bank_ids"))
    conn.execute(text("DROP TABLE IF EXISTS _reset_dingtalk_attachment_ids"))
    expense_conditions = ["source = 'dingtalk'", "approval_instance_id IS NOT NULL"]
    params: dict[str, str] = {}
    if store_id:
        expense_conditions.append("store_id = :store_id")
        params["store_id"] = store_id
    if ledger_period:
        expense_conditions.append("ledger_period = :ledger_period")
        params["ledger_period"] = ledger_period
    if approval_no:
        expense_conditions.append(
            "approval_instance_id IN (SELECT id FROM approval_instances WHERE approval_no = :approval_no)"
        )
        params["approval_no"] = approval_no
    conn.execute(
        text(
            """
            CREATE TEMP TABLE _reset_dingtalk_expense_ids ON COMMIT DROP AS
            SELECT id
            FROM expense_items
            WHERE {filters}
            """
            .format(filters=" OR ".join(f"({clause})" for clause in expense_conditions))
        ),
        params,
    )
    conn.execute(
        text(
            """
            CREATE TEMP TABLE _reset_dingtalk_bank_ids ON COMMIT DROP AS
            SELECT DISTINCT bank_transaction_id AS id
            FROM expense_bank_matches
            WHERE expense_item_id IN (SELECT id FROM _reset_dingtalk_expense_ids)
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE TEMP TABLE _reset_dingtalk_attachment_ids ON COMMIT DROP AS
            SELECT id
            FROM attachments
            WHERE source = 'dingtalk'
               OR (
                    resource_type = 'expense_item'
                    AND resource_id IN (SELECT id FROM _reset_dingtalk_expense_ids)
               )
            """
        ),
        {},
    )


def refresh_affected_bank_matched_amount(conn: Connection) -> None:
    conn.execute(
        text(
            """
            UPDATE bank_transactions AS bank
            SET matched_amount =
                COALESCE(
                    (
                        SELECT sum(match.amount)
                        FROM expense_bank_matches AS match
                        WHERE match.bank_transaction_id = bank.id
                          AND match.status = 'confirmed'
                    ),
                    0
                )
                +
                COALESCE(
                    (
                        SELECT sum(match.amount)
                        FROM revenue_bank_matches AS match
                        WHERE match.bank_transaction_id = bank.id
                          AND match.status = 'confirmed'
                    ),
                    0
                )
            WHERE bank.id IN (SELECT id FROM _reset_dingtalk_bank_ids)
            """
        )
    )


def reset_dingtalk_sync(
    conn: Connection,
    *,
    store_id: str | None = None,
    ledger_period: str | None = None,
    approval_no: str | None = None,
) -> dict[str, int]:
    create_dingtalk_temp_tables(conn, store_id=store_id, ledger_period=ledger_period, approval_no=approval_no)
    counts = {
        "dingtalk_expense_items": scalar_int(conn, "SELECT count(*) FROM _reset_dingtalk_expense_ids"),
        "dingtalk_related_attachments": scalar_int(conn, "SELECT count(*) FROM _reset_dingtalk_attachment_ids"),
        "affected_bank_transactions": scalar_int(conn, "SELECT count(*) FROM _reset_dingtalk_bank_ids"),
        "expense_bank_matches": scalar_int(
            conn,
            """
            SELECT count(*)
            FROM expense_bank_matches
            WHERE expense_item_id IN (SELECT id FROM _reset_dingtalk_expense_ids)
            """,
        ),
        "approval_instances": scalar_int(conn, "SELECT count(*) FROM approval_instances"),
        "template_field_mappings": scalar_int(conn, "SELECT count(*) FROM template_field_mappings"),
        "approval_templates": scalar_int(conn, "SELECT count(*) FROM approval_templates"),
        "dingtalk_departments": scalar_int(conn, "SELECT count(*) FROM dingtalk_departments"),
        "dingtalk_sync_jobs": scalar_int(
            conn,
            f"""
            SELECT count(*)
            FROM sync_jobs
            WHERE job_type IN ({DINGTALK_SYNC_JOB_TYPE_SQL})
            """,
        ),
    }

    conn.execute(
        text(
            """
            DELETE FROM expense_bank_matches
            WHERE expense_item_id IN (SELECT id FROM _reset_dingtalk_expense_ids)
            """
        )
    )
    conn.execute(text("DELETE FROM attachments WHERE id IN (SELECT id FROM _reset_dingtalk_attachment_ids)"))
    conn.execute(text("DELETE FROM expense_items WHERE id IN (SELECT id FROM _reset_dingtalk_expense_ids)"))
    conn.execute(text("DELETE FROM approval_instances"))
    conn.execute(text("DELETE FROM template_field_mappings"))
    conn.execute(text("DELETE FROM approval_templates"))
    conn.execute(text("DELETE FROM dingtalk_departments"))
    conn.execute(
        text(
            """
            UPDATE dingtalk_configs
            SET last_template_sync_at = NULL,
                last_instance_sync_at = NULL,
                updated_at = now()
            """
        )
    )
    conn.execute(
        text(
            """
            UPDATE dingtalk_auto_sync_settings
            SET approval_watermark_at = NULL,
                approval_resume_state = NULL,
                last_job_id = NULL,
                last_status = NULL,
                last_error = NULL,
                last_run_at = NULL,
                updated_at = now()
            """
        )
    )
    conn.execute(text(f"DELETE FROM sync_jobs WHERE job_type IN ({DINGTALK_SYNC_JOB_TYPE_SQL})"))
    refresh_affected_bank_matched_amount(conn)
    return counts


def reset_all_test_data(conn: Connection) -> dict[str, int]:
    tables = (
        "revenue_bank_match_records",
        "revenue_bank_matches",
        "expense_bank_matches",
        "attachments",
        "expense_items",
        "approval_instances",
        "template_field_mappings",
        "approval_templates",
        "dingtalk_departments",
        "revenue_records",
        "bank_transactions",
        "ledgers",
        "sync_jobs",
    )
    counts = count_tables(conn, tables)
    conn.execute(
        text(
            """
            UPDATE dingtalk_configs
            SET last_template_sync_at = NULL,
                last_instance_sync_at = NULL,
                updated_at = now()
            """
        )
    )
    conn.execute(
        text(
            """
            UPDATE dingtalk_auto_sync_settings
            SET approval_watermark_at = NULL,
                approval_resume_state = NULL,
                last_job_id = NULL,
                last_status = NULL,
                last_error = NULL,
                last_run_at = NULL,
                updated_at = now()
            """
        )
    )
    for table in tables:
        conn.execute(text(f"DELETE FROM {table}"))
    return counts


def reset_approval_rebuild(conn: Connection) -> dict[str, int]:
    create_dingtalk_temp_tables(conn)
    counts = {
        "dingtalk_expense_items": scalar_int(conn, "SELECT count(*) FROM _reset_dingtalk_expense_ids"),
        "dingtalk_related_attachments": scalar_int(conn, "SELECT count(*) FROM _reset_dingtalk_attachment_ids"),
        "affected_bank_transactions": scalar_int(conn, "SELECT count(*) FROM _reset_dingtalk_bank_ids"),
        "expense_bank_matches": scalar_int(
            conn,
            """
            SELECT count(*)
            FROM expense_bank_matches
            WHERE expense_item_id IN (SELECT id FROM _reset_dingtalk_expense_ids)
            """,
        ),
        "approval_instances": scalar_int(conn, "SELECT count(*) FROM approval_instances"),
        "template_field_mappings": scalar_int(conn, "SELECT count(*) FROM template_field_mappings"),
        "approval_templates": scalar_int(conn, "SELECT count(*) FROM approval_templates"),
        "dingtalk_departments": scalar_int(conn, "SELECT count(*) FROM dingtalk_departments"),
        "dingtalk_sync_jobs": scalar_int(
            conn,
            f"""
            SELECT count(*)
            FROM sync_jobs
            WHERE job_type IN ({DINGTALK_SYNC_JOB_TYPE_SQL})
            """,
        ),
    }
    conn.execute(
        text(
            """
            DELETE FROM expense_bank_matches
            WHERE expense_item_id IN (SELECT id FROM _reset_dingtalk_expense_ids)
            """
        )
    )
    conn.execute(text("DELETE FROM attachments WHERE id IN (SELECT id FROM _reset_dingtalk_attachment_ids)"))
    conn.execute(text("DELETE FROM expense_items WHERE id IN (SELECT id FROM _reset_dingtalk_expense_ids)"))
    conn.execute(text("DELETE FROM approval_instances"))
    conn.execute(
        text(
            """
            UPDATE dingtalk_auto_sync_settings
            SET approval_watermark_at = NULL,
                approval_resume_state = NULL,
                last_job_id = NULL,
                last_status = NULL,
                last_error = NULL,
                last_run_at = NULL,
                updated_at = now()
            """
        )
    )
    conn.execute(
        text(
            """
            UPDATE dingtalk_configs
            SET last_instance_sync_at = NULL,
                updated_at = now()
            """
        )
    )
    conn.execute(text("DELETE FROM sync_jobs WHERE job_type IN ({})".format(DINGTALK_SYNC_JOB_TYPE_SQL)))
    refresh_affected_bank_matched_amount(conn)
    return counts


def print_counts(counts: dict[str, int]) -> None:
    width = max((len(key) for key in counts), default=0)
    for key, count in counts.items():
        print(f"{key.ljust(width)}  {count}")


def main() -> int:
    args = parse_args()
    if args.execute and not args.yes_i_know_this_deletes_data:
        print("Refusing to execute without --yes-i-know-this-deletes-data.", file=sys.stderr)
        return 2

    url = make_url(args.database_url)
    if url.get_backend_name() != "postgresql":
        print(f"Refusing to run against non-PostgreSQL backend: {url.get_backend_name()}", file=sys.stderr)
        return 2

    engine = create_engine(args.database_url, pool_pre_ping=True)
    mode = "EXECUTE" if args.execute else "DRY-RUN"
    print(f"Mode: {mode}")
    print(f"Scope: {args.scope}")
    if args.store_id:
        print(f"Store ID: {args.store_id}")
    if args.ledger_period:
        print(f"Ledger period: {args.ledger_period}")
    if args.approval_no:
        print(f"Approval no: {args.approval_no}")
    print(f"Database: {url.render_as_string(hide_password=True)}")
    print("")

    with engine.connect() as conn:
        trans = conn.begin()
        try:
            if args.scope == "approval-rebuild":
                counts = reset_approval_rebuild(conn)
            elif args.scope == "dingtalk-sync":
                counts = reset_dingtalk_sync(
                    conn,
                    store_id=args.store_id,
                    ledger_period=args.ledger_period,
                    approval_no=args.approval_no,
                )
            else:
                counts = reset_all_test_data(conn)

            print_counts(counts)
            if args.execute:
                trans.commit()
                print("\nReset committed.")
            else:
                trans.rollback()
                print("\nDry-run complete. No data was changed. Re-run with --execute --yes-i-know-this-deletes-data.")
        except Exception:
            trans.rollback()
            raise

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
