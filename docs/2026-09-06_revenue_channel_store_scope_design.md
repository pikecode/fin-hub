# Revenue Channel Store Scope Design

## Goal

Revenue channels must support store-level availability.

## Requirements

- Channels created from `/revenue-channels` can be enabled for all stores or selected stores.
- Channels created from `/revenue?store_id=...` should default to the current store only.
- Channels support delete and disable.
- Disabled or deleted channels must not appear in store revenue entry lists.
- Historical revenue records and match history must remain readable.

## Recommended Model

### Channel master data

Keep `revenue_channels` as the channel master table.

Add:

- `scope_mode`: `all_stores | selected_stores`
- `deleted_at`: nullable timestamp
- `deleted_by`: nullable string

Keep:

- `status`: `active | inactive`

Suggested behavior:

- `active` + not deleted: usable
- `inactive`: hidden from store entry lists, preserved for history
- `deleted_at` set: hidden from store entry lists, preserved for history

### Store scope mapping

Add a link table:

- `revenue_channel_store_links`
- `channel_id`
- `store_id`
- `created_at`
- `updated_at`

Rules:

- `scope_mode = all_stores` means the channel is usable everywhere.
- `scope_mode = selected_stores` means only linked stores can use it.
- `/revenue-channels` edits the full scope set.
- `/revenue` creates a channel with `selected_stores` containing only the current store.

## UI Behavior

### `/revenue-channels`

- Show a store scope selector in create/edit modal.
- Default to all stores.
- Allow editing the selected store list.
- Show current scope summary in the table.
- Keep delete and enable/disable actions in the list.

### `/revenue`

- Create-channel entry should open a modal, not a full page jump.
- New channel should default to the current store only.
- The channel should immediately be available in that store's revenue workflow.

## Delete / Disable Rules

- Disable should make a channel unavailable for new revenue records.
- Delete should be soft delete, not hard delete.
- Historical revenue records must keep their original `channel` text.
- Historical revenue-bank matches must keep their original `channel` text.
- Existing records should remain visible in reports and reconciliation pages.

## API Changes

- `GET /revenue-channels` should return scope summary.
- `POST /revenue-channels` should accept scope mode and store ids.
- `PATCH /revenue-channels/{id}` should update name, sort order, status, and scope.
- Add `DELETE /revenue-channels/{id}` as a soft delete endpoint.
- `ensure_active_channel` should validate both status and store scope.

## Migration Strategy

1. Add the new scope table and soft-delete fields.
2. Backfill existing channels to `all_stores`.
3. Backfill seeded demo channels to `all_stores`.
4. Update revenue entry screens to filter by store scope.
5. Add delete/disable handling without rewriting historical revenue data.

## Open Questions

- Should "delete" be a hard delete for channels with no history, or always soft delete?
- Should inactive/deleted channels stay visible in `/revenue-channels` with badges, or be hidden there too?
- Should scope editing support store groups later, or only direct store selection for now?

## Recommendation

- Use soft delete for all channels.
- Keep inactive/deleted channels visible only in the master data page.
- Start with direct store selection; add store groups later if needed.
