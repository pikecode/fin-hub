# Revenue Channel Store Scope Implementation Plan

## What Changes

- Add store-scope support to `revenue_channels`.
- Add a channel-store link table for selected-store mode.
- Add soft delete fields for revenue channels.
- Update revenue channel create/edit UI.
- Update revenue entry pages to filter channels by store scope.

## Data Model

### `revenue_channels`

Add:

- `scope_mode` (`all_stores` | `selected_stores`)
- `deleted_at`
- `deleted_by`

Keep:

- `status`
- `requires_bank_match`
- `sort_order`

### `revenue_channel_store_links`

New table:

- `id`
- `channel_id`
- `store_id`
- `created_at`
- `updated_at`

Constraints:

- unique `(channel_id, store_id)`
- cascade delete on channel delete

## API

### Create/update channel

- `/api/revenue-channels`
- accept `scope_mode`
- accept `store_ids` when `scope_mode=selected_stores`
- default to `all_stores` on the master page
- default to current store only on the revenue page

### Delete channel

- add `DELETE /api/revenue-channels/{id}`
- soft delete only
- hidden from new entry lists after delete

### Channel validation

- `ensure_active_channel` must reject inactive/deleted channels
- when `scope_mode=selected_stores`, the current store must be linked

## UI

### `/revenue-channels`

- show scope selector
- show selected stores summary
- allow edit of scope
- add delete action
- keep enable/disable action

### `/revenue`

- use a modal for creating a channel
- default scope to the current store
- return to the page with the new channel selected

## Historical Data

- revenue records keep the original `channel` string
- revenue bank matches keep the original `channel` string
- disabling/deleting a channel must not rewrite historical rows

## Rollout

1. add migration and models
2. update API schemas and handlers
3. update shared API client/types
4. update admin web pages
5. verify channel filtering in revenue entry and reconciliation pages

