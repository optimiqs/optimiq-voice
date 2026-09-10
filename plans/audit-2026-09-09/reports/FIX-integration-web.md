# FIX — AREA: integration-web (all of `apps/web`)

Picks up the cross-area items left by the `web-app` and `web-lib` fix agents.

## 1. `voicemail.write.own` — FIXED

`pnpm --filter @optimiq-voice/web run codegen` re-ran `scripts/sync-permissions.ts`:
`lib/permissions.generated.ts` gained 11 lines (the four `voicemail.*.own` registry entries plus the
role-template grants); the count is now **121 permissions and 5 role templates**. This also cleared
the `lib/permissions.spec.ts(51,53)` typecheck error the web-app agent reported as out-of-area.

The API's message routes were then read directly rather than trusted second-hand
(`apps/api/src/pbx/voicemail-boxes/voicemail-messages.controller.ts`) — **all four** accept the
`.own` scope:

| route                                   | permission             |
| --------------------------------------- | ---------------------- |
| `GET :id/messages`                      | `voicemail.read.own`   |
| `PATCH :id/messages/:messageId`         | `voicemail.write.own`  |
| `DELETE :id/messages/:messageId`        | `voicemail.delete.own` |
| `POST :id/messages/:messageId/play-url` | `voicemail.listen.own` |

So the gating is now:

- `app/(app)/voicemail/_components/voicemail-messages-dialog.tsx` — `canWrite` / `canDelete` /
  `canListen` moved from `voicemail.{write,delete,listen}` to the `.own` scopes, with a comment
  saying why. This is the mark read/unread control, the delete and the play button. No new helper
  was needed: `lib/permissions.ts#hasPermission` already treats an unscoped grant as covering its
  scopes, so a supervisor holding `voicemail.write` still passes — which is exactly the convention
  `lib/page-permissions.ts` and the server guard use.
- `app/(app)/voicemail/_components/voicemail-screen.tsx:57` — the gate on the **Messages…** row
  action (`voicemail.listen`) is now `voicemail.listen.own`, so an agent with only the `.own` grants
  can reach their own mailbox at all. Without this the dialog fix would have been unreachable.

Deliberately **not** changed, because the API still demands the unscoped grant there:
`voicemail-greetings-dialog.tsx` (`voicemail-greetings.controller.ts` is unscoped throughout) and
`use-live-queries.ts:435` (`live-topics.ts:87` maps the `voicemail` topic to `voicemail.read`).

`codegen:check` passes.

## 2. Debounced server-side search in the shared pickers — FIXED

`components/pbx/resource-select.tsx` — all three exports (`ResourceSelect`, `PromptSelect`,
`ResourceOrderedList`) now hold a search box whose term is debounced 250 ms and sent to the server
as `?search=` (`pbxListSearchParams` already emits it; `listPrompts` inherits it). The single page
is still `MAX_PAGE_LIMIT`, but it is now the hundred rows that MATCH rather than the hundred that
sort first, so nothing past the first 100 is unreachable. The term is part of `queryKeys.pbxList` /
`queryKeys.promptList` so pages are cached per search, and `placeholderData: (previous) => previous`
keeps the last page on screen between keystrokes instead of blanking the select.

Keeping the selected value renderable is the other half, and it is now the common case rather than
the odd one. New **`lib/pbx/picker.ts`** holds the two pure decisions:

- `pickerSearchTerm(input)` — trims, `undefined` when blank, which keeps the _unsearched_ query key
  and URL byte-identical to what the picker sent before this change.
- `mergeSelectedOption(options, value, remembered, fallbackLabel)` — prepends the selected row when
  the current page does not hold it, labelled from what the picker has already seen, falling back to
  the old `Currently: <id>…`. It goes first so it is visible without scrolling a hundred rows.

Both pickers remember labels in `useState` (not a ref) with a "learned nothing new → set nothing"
guard, because learning a label has to redraw the option that was showing a truncated id. The same
treatment fixed a latent bug in `ResourceOrderedList`: it named the chain's entries from the current
page's `byId`, so under search every trunk already in the failover chain would have rendered as
`… (not found)`. Its `available` filter also moved from `value.includes` inside a `.filter`
(O(n·m)) to a `Set`. Its empty option now distinguishes "no match" from "everything is listed".

**No call site needed editing** — all 20 picker sites the web-app report lists go through these
three components, which is the argument for the shared shell in the first place.

`useDebounced` was lifted out of `components/pbx/resource-list.tsx` into
**`components/pbx/use-debounced.ts`** and imported by both; it removes duplication rather than
adding an abstraction, and `resource-list.tsx` lost three now-unused React imports.

**Spec added**: `lib/pbx/picker.spec.ts`, 8 cases (bun test) — blank/whitespace/trimmed terms, the
term surviving `pbxListSearchParams` onto the wire at `limit=100`, the unsearched query still
carrying no `search` param, and the four `mergeSelectedOption` branches (identity when nothing is
selected or the page holds it; remembered label when the search filtered it out; never-seen id still
offered). The debounce hook itself is not covered: this package has no React renderer (no
`@testing-library/*`, no `react-test-renderer`, no `happy-dom`), which is why the testable decisions
were extracted as pure functions instead.

## 3. Remaining Cross-area items

- **web-lib → `app/layout.tsx:25` favicon** — verified, **no change needed**. `apps/web/public/favicon.svg`
  exists and the Dockerfile `COPY` is in place, so `icons: { icon: "/favicon.svg" }` resolves.
- **web-app → `lib/query-keys.ts:210` (`cdrCall` third arg)** — already landed under the granted
  exception; typecheck confirms the `use-cdr-queries.ts` caller matches.
- **web-app → "no test added, `app/` has no harness"** — confirmed and unchanged; the new spec is in
  `lib/`, which is where the harness lives.
- **web-lib → optional API-side `snapshot` id echo** — outside `apps/web`, not actioned.

## Additional fixes noticed while in these files

- `ResourceOrderedList` chain-entry labels under search (above) — would have read "(not found)" for
  rows that plainly exist.
- `ResourceOrderedList`'s `available` filter complexity (above).
- The search `<input>` is deliberately `aria-label`-led rather than carrying a second `<label>`,
  which would have given the field two accessible names.

## Cross-area needed

None. Everything above is inside `apps/web`.

## Verification (final run, exact output)

- `pnpm exec turbo run build --filter=@optimiq-voice/auth` → **3 successful, 3 total** (cached), so
  the permissions codegen read a current `dist`.
- `pnpm --filter @optimiq-voice/web run typecheck` → **0 errors** (`tsc -p tsconfig.json --noEmit`,
  no output, exit 0). The `permissions.spec.ts` error the web-app agent reported is gone.
- `pnpm --filter @optimiq-voice/web run test` → **764 pass, 0 fail**, 2586 expect() calls, 33 files.
  (Was 756/32 before this agent; +8 cases, +1 file — `lib/pbx/picker.spec.ts`.)
- `pnpm --filter @optimiq-voice/web run codegen:check` → `permissions.generated.ts is up to date.`,
  exit 0.
- `pnpm exec oxlint apps/web` → exit 0, **no diagnostics** (one `exhaustive-deps` warning appeared
  mid-work on the ordered list's effect and was closed by keying it on `query.data?.data` rather
  than a per-render array).
- `pnpm exec oxfmt apps/web` → exit 0, 338 files.

## Files touched

```
M  apps/web/lib/permissions.generated.ts            (codegen, +11)
M  apps/web/app/(app)/voicemail/_components/voicemail-messages-dialog.tsx
M  apps/web/app/(app)/voicemail/_components/voicemail-screen.tsx
M  apps/web/components/pbx/resource-select.tsx
M  apps/web/components/pbx/resource-list.tsx        (useDebounced extracted out)
A  apps/web/components/pbx/use-debounced.ts
A  apps/web/lib/pbx/picker.ts
A  apps/web/lib/pbx/picker.spec.ts
```
