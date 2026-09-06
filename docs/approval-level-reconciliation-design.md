# Approval Level Reconciliation Design

## Goal

Finance reconciliation should match and confirm at the approval instance level, not at the expense-item line level.

## Why Change

Current reconciliation behavior exposes approval candidates as expense-item rows. That causes:

- duplicate approval numbers in the candidate list
- user confusion about what is actually being matched
- approval-level workflows being represented as line-level workflows

Business rule:

- one approval = one reconciliation candidate
- approval detail rows are for viewing, not for matching

## Current State

The system already stores both layers:

- `approval_instances` for DingTalk approval headers
- `expense_items` for parsed expense rows and source metadata
- `expense_bank_matches` for bank-to-expense matches

But the reconciliation flow still uses:

- `expense_item_id` as the match anchor
- candidate listing built from `ExpenseItem` rows
- confirm/edit/unmatch logic tied to expense lines

## Recommended Approach

Use the approval header as the matching unit, while keeping expense items as the parsed detail layer.

### Core Rule

- candidate list groups by `approval_instance_id`
- one approval instance produces one candidate row
- matching chooses the approval header, not a specific detail row
- detail rows stay visible in a read-only drilldown

### Data Model

Preferred path:

- keep `expense_items` as detail records
- keep `expense_bank_matches` for historical compatibility only
- make `approval_instance_id` the primary match anchor for new reconciliation flows
- keep `expense_item_id` only as a traceability link to underlying detail rows
- do not let the UI treat individual expense rows as the primary match target

If stronger separation is needed later:

- add a dedicated approval-level match table
- migrate reconciliation actions to that table
- keep old expense-level records only for history and backward compatibility

## Implementation Plan

### Phase 1: Candidate Aggregation

- group candidate results by `approval_instance_id`
- show only the approval header in the candidate list
- aggregate total amount from the approval summary row
- keep detail rows available in the candidate drawer/modal

### Phase 2: Match API

- change match creation to accept `approval_instance_id`
- validate that only one active bank match exists per approval
- keep amount, accounting period, reason, and category on the approval match record

### Phase 3: Reconciliation Records

- display historical confirmed matches as approval-level records
- preserve links to underlying expense rows for traceability
- keep edit and unmatch actions at approval level

### Phase 4: Frontend

- candidate card title should be approval number
- remove selectable expense-row radio controls from confirm flow
- detail table becomes read-only
- selection state should be approval-based

### Phase 5: Backward Compatibility

- do not break existing confirmed records
- keep old expense-level matches readable
- stop creating new expense-level matches in the UI
- add migration or adapter logic only if historical records must be edited

## Status Rules

- approval instance status has only two user-facing states: `unmatched` and `matched`
- detail rows do not carry their own reconciliation state
- an approval is `matched` only when the approval header has an active bank match
- there is no user-facing `partial match` state
- historical records may keep internal trace fields, but the list UI must stay binary

## Detail Rules

- expense item rows are classification and traceability data, not match targets
- when an approval is matched, its detail rows remain visible for review
- detail rows may still receive category values for analytics
- missing detail categories do not block approval-level matching
- matching the approval does not require each detail row to be fully classified first

## Migration Strategy

Recommended rollout:

1. ship approval-level read path first
2. keep old expense-level write path during transition
3. add tests for approval-level uniqueness
4. cut over confirm/edit/unmatch after the UI is stable

If the old workflow must be retired completely:

- backfill approval-level match references from existing expense matches
- verify one approval maps to one active bank match
- remove expense-row selection from the page

## Acceptance Criteria

- candidate list shows each approval only once
- duplicate approval numbers disappear from the candidate list
- a user cannot match one approval by picking arbitrary expense rows
- approval detail rows remain visible for inspection
- existing confirmed records remain accessible

## Open Questions

- Should historical expense-level matches remain editable?
- Should approval-level matching coexist with expense-level matching during transition?
- Should the approval summary row be the only selectable candidate, or should the backend aggregate detail rows dynamically when no summary row exists?

Recommended answers:

- historical expense-level matches should remain read-only unless explicitly migrated
- approval-level matching should coexist only during rollout, then become the only write path
- the backend should aggregate detail rows dynamically when no summary row exists, but still expose one approval candidate
