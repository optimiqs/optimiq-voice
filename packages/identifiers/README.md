# @optimiq-voice/identifiers

Canonical entity identifiers for Optimiq Voice. Every internal entity id is a UUID — plain
`string` in TypeScript, enforced at the database schema and at the HTTP boundary.

## API

| Export                              | Purpose                                                               |
| ----------------------------------- | --------------------------------------------------------------------- |
| `createEntityId()`                  | UUID v7 for a newly persisted entity (time-ordered, index friendly).  |
| `createDeterministicEntityId(key)`  | UUID v3 under a frozen namespace — idempotent provisioning / cutover. |
| `isEntityId(value)`                 | Accepts any valid UUID version.                                       |
| `isUuidV7EntityId(value)`           | Enforces the v7 policy for newly created entities.                    |
| `DETERMINISTIC_ENTITY_ID_NAMESPACE` | Frozen namespace UUID. **Never rotate.**                              |

## Rules

- New rows always use `createEntityId()`. Do not generate UUIDs anywhere else.
- `createDeterministicEntityId` is only for keys that must resolve to the same id forever
  (managed resource provisioning, legacy id migration). The key must be canonical and
  fully qualified, e.g. `extension:<workspaceId>:<number>`.
- Rotating `DETERMINISTIC_ENTITY_ID_NAMESPACE` re-keys every derived entity. It is frozen.

## Commands

```sh
pnpm --filter @optimiq-voice/identifiers build
pnpm --filter @optimiq-voice/identifiers typecheck
bun test packages/identifiers/src
```
