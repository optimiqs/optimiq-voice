# FIX — voicemail message forward / copy

Closes **E2E-routing2.md P2-2** ("there is no voicemail forward or copy" — `POST
…/messages/:messageId/forward` was a flat 404) and moves the CAPABILITY-MATRIX row
"Voicemail — forward / copy / move: UNPROVEN" to proven, live.

## What was built

`forward` and `copy` are **one route and one code path** with a `mode`, because they are the same
operation with one extra step: both write the AUDIO and a ROW into another mailbox, and only
`forward` then removes the original. Two endpoints would have been two places that had to be kept in
step about tenancy, the object copy and the two lamps.

```
POST /api/v1/voicemail-boxes/:id/messages/:messageId/forward
  { "targetVoicemailBoxId": "<uuid>", "mode": "forward" | "copy" }   // mode defaults to "forward"
  201 -> { data: <the copy>, mailbox: <target counts>, source: <source counts>, mode }
```

### The decisions worth reading

| decision               | what it is                                                                           | why                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Permission**         | `voicemail.write.own` on the route                                                   | the SOURCE box is what the caller must be entitled to — a forward removes a message from it, a copy reads one out of it. An unscoped `voicemail.write` still satisfies it by the substitution rule.                                                                                                                                                                               |
| **Source reach**       | the ordinary `.own` narrowing (`assertMayReachBox`)                                  | a self-service user forwards out of their own mailbox and nobody else's                                                                                                                                                                                                                                                                                                           |
| **Target reach**       | **tenancy only** — no ownership check                                                | a user who could only forward INTO boxes they own could only forward to themselves, which is the opposite of the feature. `requireBox` runs inside `withTenantScope`, so a foreign box id is invisible to RLS and answers **404** — indistinguishable from an id that never existed, which is what stops the endpoint being an oracle for another tenant's mailbox ids.           |
| **Same-box**           | 400 `VOICEMAIL_FORWARD_TARGET_INVALID`                                               | it would file a second copy into the box that already holds it and light that box's own lamp                                                                                                                                                                                                                                                                                      |
| **Object before row**  | bytes are `put` under a new key first; the row transaction failing unlinks it        | the branding-upload rule (`branding-logo-upload.service.ts`): an object with no row is inert and reapable, a row pointing at a missing object is a message that plays as an error                                                                                                                                                                                                 |
| **The source object**  | **never** unlinked, even on a forward                                                | retention owns the object store's lifecycle here as everywhere else in this file (see `remove`), and the copy is a new object under its own key                                                                                                                                                                                                                                   |
| **The copy's key**     | `<organizationId>/<newMessageId>.<ext>`, extension carried from the source           | byte-identical in shape to what the deposit path writes, so an operator cannot tell a forwarded message from a deposited one — which is right, it IS one. Every segment but the extension is a UUID this server minted, so `ObjectStore.put`'s containment check has nothing to escape with.                                                                                      |
| **`sizeBytes`**        | taken from the bytes actually read, not from the source row                          | a copy never inherits a `size_bytes` the store disagrees with. Proved live: the source row's was `null`; the copy's is 253 164.                                                                                                                                                                                                                                                   |
| **The copy's folder**  | always `new`                                                                         | to the recipient this message has just arrived, and the folder IS the lamp                                                                                                                                                                                                                                                                                                        |
| **The transcript**     | travels only when the source is `done`                                               | a copy carrying `pending` would be a row nothing is coming for — the transcription queue is fed by the deposit path and no worker is ever handed this message                                                                                                                                                                                                                     |
| **MWI**                | target always (`message-left`); source **only on a forward** (`message-deleted`)     | a copy leaves the source exactly as it was, so an event for it would claim a change that did not happen. Both counts are read back inside the same transaction as the write, per `voicemail-mwi.publisher.ts`.                                                                                                                                                                    |
| **Voicemail-to-email** | `VoicemailEmailService.notify(org, targetBox, copyId)`, best-effort after the commit | the deposit path's own service, not a re-published event: the whole decision tree (org policy, box mode and address, the `email_sent_at` compare-and-set that makes it once) already lives there, and a forwarded message is a message arriving in a mailbox by every test that tree applies. The COPY's id is passed, never the original's — `email_sent_at` is a per-row claim. |
| **Audit**              | one ledger row, `voicemail-message.forward` / `.copy`                                | `before` names the box it came from, `after` names where it went. Closes the message-action half of the `E2E-records.md` F9 ledger gap for the one action that moves a recording between two people.                                                                                                                                                                              |
| **Recorded intro**     | **out of scope**, stated in the DTO, the client and the dialog                       | prepending a fresh recording to the forwarded audio needs a recording leg on the call path. That is `apps/engine`'s to own; nothing in the control plane (or the browser) can fabricate one.                                                                                                                                                                                      |

No migration was needed: every column the copy writes already exists on `voicemail_message`.
`packages/pbx-db` was not touched.

## Files

**API**

- `apps/api/src/pbx/voicemail-boxes/voicemail-messages.dto.ts` — `forwardVoicemailMessageDto`
- `apps/api/src/pbx/voicemail-boxes/voicemail.errors.ts` — `VoicemailForwardTargetInvalidException`
- `apps/api/src/pbx/voicemail-boxes/voicemail-messages.controller.ts` — the route
- `apps/api/src/pbx/voicemail-boxes/voicemail-messages.service.ts` — `forward`, `copyObject`,
  `unlink`, `notifyTarget`, the `VoicemailForwardResult` shape, `VoicemailEmailService` injected
- same file, **incidental fix**: `requireMessage` returned `void` and re-read the row nowhere. It now
  returns the row it already proved exists, so the forward path does not need a second query; the
  key it needs is on a separate `StoredMessageRow` so the LIST query keeps not selecting `objectKey`
  — a column that is never selected cannot be leaked by a `toWireMessage` that forgets to drop it.
- `apps/api/test/pbx/voicemailForward.test.ts` — **new**, 13 cases
- `apps/api/test/pbx/voicemailTranscription.test.ts` — its `VoicemailMessagesService` harness gained
  the new constructor argument (typecheck fix, no behaviour change)

**Web**

- `apps/web/lib/pbx/contracts.ts` — `VOICEMAIL_FORWARD_MODES`, `VoicemailForwardResult`
- `apps/web/lib/pbx/client.ts` — `forwardVoicemailMessage`
- `apps/web/lib/pbx/voicemail-forward.ts` — **new**, the two pure decisions
- `apps/web/lib/pbx/voicemail-forward.spec.ts` — **new**, 6 cases
- `apps/web/app/(app)/_hooks/use-voicemail-queries.ts` — `useForwardVoicemailMessage`; invalidates
  **both** mailboxes, because a cached page of the destination would otherwise be missing the message
  the user just sent to it
- `apps/web/app/(app)/voicemail/_components/voicemail-forward-dialog.tsx` — **new**; the picker is the
  shared `ResourceSelect` over `voicemail-boxes` (tenant-scoped, searchable, capped), the destination
  resets on every opening so the second forward of a session is not one careless press from the
  previous recipient
- `apps/web/app/(app)/voicemail/_components/voicemail-messages-dialog.tsx` — "Forward…" / "Copy to…"
  row actions behind `voicemail.write.own`, hidden on trashed rows, one dialog for both

## Proved live on the running stack

api restarted (see `STACK.md`'s restart log — including the four-minute outage that was NOT mine and
the `packages/events` rebuild that cleared it). Scripts in `<scratchpad>/vmfwd/`.

```
A(1202) rows=10 new=10   B(1203) rows=3 new=3
source message 01a087fd-3eb7-… from 1201, 15 820 ms, sizeBytes=null

1. same-box      -> 400 VOICEMAIL_FORWARD_TARGET_INVALID
2. foreign box   -> 404 VOICEMAIL_NOT_FOUND          (a mailbox id from the SMOKE org)
3. copy A->B     -> 201 mode=copy  target=1203 new=3->4  sourceNew=10 (unchanged)
                    A rows 10->10,  B rows 3->4
4. the copy PLAYS-> 200, 253 164 bytes, header "RIFF"   (signed link, real audio, new object)
5. fwd  B->C     -> 201 mode=forward  targetNew=2  sourceNew=3
                    B rows 4->3 (the original left),  C rows ->2
6. ledger        -> 2 rows: voicemail-message.forward, voicemail-message.copy
                    before={voicemailBoxId:…1203, mailboxNumber:"1203", removed:true}
                    after ={voicemailBoxId:…1204, mailboxNumber:"1204"}
7. cleanup       -> 200; A rows=10  B rows=3  C rows=1   (fixtures exactly as found)
```

MWI on the live channel, subscribed to `voicemail`:

```
COPY  A->B: 1 frame  — voicemail.evt.v1.<org>.<1203>.mwi.updated          (target only)
FWD   B->C: 2 frames — voicemail.evt.v1.<org>.<1204>.mwi.updated          (target)
                       voicemail.evt.v1.<org>.<1203>.mwi.updated          (source)
restored 1202 rows=10 new=10 · 1203 rows=3 new=3 · 1204 rows=1 new=1
```

Not proved live: **voicemail-to-email for the target**. The fixture org has no mailbox with an email
mode set, and turning one on would have been a config change in another agent's tenant. The wiring is
covered by a unit case that asserts `notify` is called for the TARGET box with the COPY's id.

## Verification (exact counts)

| check                                            | result                                                                                                                                                                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @optimiq-voice/api run typecheck` | 1 error, **not mine**: `src/pbx/feature-codes/feature-codes.service.ts(79,59)` — a concurrent agent's in-flight edit. Zero errors in any file I touched.                                                                         |
| `pnpm --filter @optimiq-voice/api run test`      | **1413 passing, 1 failing** — the failure is `org settings catalogue › only catalogues routing names the compiler actually reads`, a concurrent agent adding `defaultCallingCode`. My new file alone: **13 passing, 0 failing**. |
| `pnpm --filter @optimiq-voice/web run typecheck` | clean                                                                                                                                                                                                                            |
| `pnpm --filter @optimiq-voice/web run test`      | **864 pass, 0 fail** (was 861 before; +6 new cases, bun counts differently per file)                                                                                                                                             |
| `pnpm exec oxlint <my dirs>`                     | clean, no output                                                                                                                                                                                                                 |
| `pnpm exec oxfmt --check <my dirs>`              | "All matched files use the correct format" (74 files)                                                                                                                                                                            |

Nothing was committed, staged or stashed.

## Cross-area needed

- **`packages/events` build hygiene** — `apps/api` resolves `@optimiq-voice/events/schemas` to
  `dist`, so an export added to `src` and not built takes the whole api down at boot with a bare
  `SyntaxError`. It cost this stack four minutes. Either point the `exports` `default` at `src` for
  dev, or have `.scripts/local-stack/up.sh api` build the workspace's changed packages first.
- **`apps/engine`, optional** — a recorded introduction on a forward needs a record-then-prepend leg.
  Deliberately not attempted here; the API shape has room for it (a body field naming a recorded
  prompt) without a breaking change.
- **`packages/routing` / feature codes, optional** — a desk phone's forward (`*` menu inside `*97`)
  would reach this through a new `rpc.voicemail.v1.forward`. The service method is already the shape
  a broker responder would call; only the entry point and its `mailboxNumber` cross-check are
  missing.
