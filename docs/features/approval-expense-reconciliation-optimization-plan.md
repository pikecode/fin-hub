# Approval Expense Reconciliation Optimization Plan

## Background

DingTalk approvals are synchronized periodically and then used by finance users to reconcile expense bank transactions. The target business model is:

- DingTalk approval instance is the source document.
- Expense item is the accounting and analysis unit.
- One approval can create one or many expense items.
- Each expense item carries category, amount, date, store, payee and source line metadata.
- Bank reconciliation links bank transactions to expense items through match records.
- Reports aggregate from expense items and confirmed matches, not from raw approval headers.

## Current Assessment

The existing model already has the right tables:

- `approval_instances`: stores DingTalk approval headers and raw payload.
- `expense_items`: stores parsed expense lines, category, store, ledger period and manual edit protection metadata.
- `expense_bank_matches`: links one expense item to one bank transaction with match amount and accounting period.
- `bank_transactions`: stores imported or manually entered bank transactions.

The DingTalk sync flow can parse table rows into multiple expense items and preserves line metadata with:

- `approval_instance_id`
- `approval_line_no`
- `approval_line_key`
- `approval_line_source_type`
- `source_document_id`

However, the reconciliation candidate flow still contains old whole-approval behavior that conflicts with the line-level design.

## Problems To Fix

### P0: Candidate Query Uses The Wrong Unit

The reconciliation candidate API excludes DingTalk expense items whose `source_document_id` contains `:`. Those records are exactly the line-level details created from approval tables. This makes the UI appear to match an approval detail, while the backend actually prefers the whole approval record.

Target behavior:

- If an approval has parsed detail rows, candidates should be those detail rows.
- If an approval has no parsed detail rows, candidates can be the single whole-approval expense item.
- Candidate labels should still include the approval header for context.

### P0: Query-Time Expense Creation Creates Duplicate Accounting Data

The candidate API currently backfills a whole-approval expense item while reading candidates. This creates side effects during a read request and can double count expenses when parsed detail rows already exist.

Target behavior:

- Expense creation and reparsing only happen in DingTalk sync/reparse flows.
- Candidate listing is read-only.
- No whole-approval fallback should be created if line-level items already exist.

### P0: Manual Category Protection Is Incomplete

Finance users can choose or edit categories during reconciliation. These changes are written to `expense_items`, but they are not always recorded in `user_edited_fields_json`. A later sync can overwrite manual category decisions.

Target behavior:

- Reconciliation create/update should mark manually supplied `category_l1` and `category_l2` as protected fields.
- Sync should continue respecting protected fields.

### P1: Scheduled Sync Should Reparse Existing Approvals Safely

Scheduled sync defaults to skipping existing approval instances. This can miss later changes in approval status, amount, detail rows, store mapping, or template mappings.

Target behavior:

- Incremental sync should refresh existing approvals in the sync window.
- Matched expense items should protect amount, store and ledger period.
- Manual fields should remain protected.
- Removed source lines should be marked, not deleted, when matched.

### P1: Backfill And Cleanup Existing Data

Existing data may contain both a whole-approval item and line-level items for the same approval.

Target behavior:

- Detect duplicate whole-approval items where line-level items exist.
- If the whole-approval item has no match, mark or remove it.
- If it has a match, keep it but mark a conflict for manual review.

## Canonical Data Flow

1. DingTalk sync pulls approval headers and detail payload.
2. Store is resolved from mapped store field, DingTalk department id or department path.
3. Approved approvals are parsed into expense items.
4. Each expense item receives category fields from line data or template mappings.
5. Reconciliation candidate API returns unpaid or partially paid expense items for the selected store and period.
6. Finance user matches one bank transaction to one or more expense items.
7. Match confirmation updates bank matched amount and expense payment status.
8. Reports aggregate expense amount by `expense_items.category_l1/category_l2` and match status by `expense_bank_matches`.

## Implementation Plan

### Phase 1: Correct Candidate Semantics

- Remove read-time `ensure_candidate_total_expenses` from candidate listing.
- Include line-level DingTalk expense items in candidate query.
- Keep filtering out sample and seed approvals.
- Add tests proving line-level candidates are returned and no whole-approval duplicate is created during candidate listing.

Status: implemented.

### Phase 2: Protect Manual Category Updates

- Add a small helper for updating `user_edited_fields_json`.
- Use it when reconciliation create/update receives category values.
- Add tests proving a later DingTalk reparse does not overwrite category fields chosen during reconciliation.

Status: implemented for reconciliation create and update.

### Phase 3: Scheduled Sync Refresh Strategy

- Change scheduled sync from `skip_existing=True` to a safe refresh mode.
- Keep manual run option flexible for explicit skip behavior.
- Add tests for approval status/detail amount updates in incremental sync.

Status: planned.

### Phase 4: Data Cleanup Tooling

- Add diagnostics for approvals with both whole-approval and line-level expense items.
- Add a guarded cleanup command or endpoint for unmatched duplicate whole-approval items.
- Produce a report before mutating any production data.

Status: planned.

## Acceptance Criteria

- A DingTalk approval with two expense detail rows appears as two reconciliation candidates.
- Matching one bank transaction to multiple approval lines is supported.
- Category changes made during reconciliation survive DingTalk reparse.
- Candidate API does not create expense rows.
- Store ledger and report expense totals are based on expense items without duplicate whole-approval totals.
- Scheduled sync keeps existing approvals current without overwriting protected accounting decisions.
