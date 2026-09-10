# FIX — P2-3, per-call CLIR (caller-ID restriction)

## Field name

`callerIdPresentation`, values `allowed` | `restricted`.

Chosen over `clir` and `privacy`: it sorts and reads beside `callerIdNumber` / `callerIdName` (same
noun, third facet of the same identity), and "presentation" is the term of art — CLIP/CLIR is
_calling line identification presentation/restriction_, and Q.931's field is the presentation
indicator. `clir` names only half the vocabulary (there is no "CLIR: allowed"); `privacy` collides
with the SIP header of that name, which is one of several things `restricted` implies, not the field.

## What was done

- **packages/events** — `sipOriginateRequestSchema.callerIdPresentation` (`z.enum(["allowed",
"restricted"]).optional()`), documented as STRUCTURED-not-a-header, referencing `headers`' own rule
  that the edge refuses names that would let the engine forge identity. Codegen run twice: byte-identical
  tree (`shasum` over all of `packages/events-go`), `git status` unchanged between runs. Produced
  `SipOriginateRequest.CallerIDPresentation *SipOriginateRequestCallerIDPresentation`.
- **engine** — `OriginateRequest.callerIdPresentation` (media-port.ts), additive-and-ignored on the
  contract `target`'s doc comment states. `SplitPlaneMediaPort.originate` sends it; `AriMediaAdapter`
  and `MediadMediaPort` ignore it (no code change — neither reads the field; both asserted).
- **engine precedence** — new private `SplitPlaneMediaPort.callerIdPresentation(request)` and exported
  `CLIR_VARIABLE = "OPTIMIQ_CLIR"`. Order: `request.variables.OPTIMIQ_CLIR` → the originating leg's
  stored `OPTIMIQ_CLIR` (a caller who dials a prefix code stamps their A-leg; the B-leg is a different
  channel) → `request.callerIdPresentation` (the setting) → absent ⇒ `allowed` at the edge. A value
  that is neither literal is ignored, not refused: an unknown override must not fail a dial.
- **originate-plan.ts** — `OriginatePlan.callerIdPresentation`, read beside `outboundCallerIdNumber`
  from `extension.outboundCallerIdPresentation` through a narrow cast, because
  `ExtensionIndexEntry` has no such field yet (below).
- **Tests** — split-plane: absent, setting-only, override-beats-setting, originator-leg override,
  garbage-falls-through. ari-media.adapter: originate with `restricted` still dials and the field does
  not reach ARI options. mediad-media.port: the refusal case now carries the field, proving an additive
  field does not change which refusal an unreached rung produces. originate-plan: setting carried,
  absent stays absent.

## No feature code was added

`DEFAULT_FEATURE_CODES` and `FeatureCodeAction` are `packages/routing`'s. Follow-up: a
`callerIdPresentation` feature-code action (`*67` restricted, `*82` allowed) whose handler writes
`OPTIMIQ_CLIR` on the A-leg. The engine half already honours it.

## Cross-area needed — the extension setting

1. `packages/routing/src/artifact.ts` — add to `ExtensionIndexEntry` (beside `outboundCallerIdName`,
   line ~345): `readonly outboundCallerIdPresentation?: "allowed" | "restricted";`. Same optional
   shape; absent ⇒ `allowed`. Bump nothing: an additive optional field is artifact-compatible.
2. `packages/routing/src/compile.ts` — in the extension-index projection that already copies
   `outboundCallerIdNumber` / `outboundCallerIdName` from the extension row, copy
   `outboundCallerIdPresentation` when the row's value is `"restricted"` (omit for `"allowed"`, so the
   artifact stays free of no-op fields). Consider the same field on `CompiledRoutingSettings` for an
   org-wide default, resolved extension-then-settings the way the caller-id number already is at
   `resolve.ts:884`.
3. **pbx-db** — `extensions.outbound_caller_id_presentation` `text not null default 'allowed'` with a
   check constraint on the two values (mirror the enum style used for `toll_class`), plus the same
   column on `org_settings` if the org-wide default is taken.
4. **API** — the extension create/update DTO and response DTO get
   `outboundCallerIdPresentation?: 'allowed' | 'restricted'`, validated as an enum, defaulting to
   `allowed`; it must appear in whatever `.own` self-service scope already governs
   `outboundCallerIdNumber`. Web: a checkbox on the extension form ("Withhold this extension's number
   on outbound calls").
5. **engine (one line, `channel-orchestrator.service.ts` ~4290, another agent's file today)** —
   `...(plan.callerIdPresentation === undefined ? {} : { callerIdPresentation:
plan.callerIdPresentation })` on the `this.media.originate({...})` call, and the same on the
   outbound-trunk originate the plan walker builds, so the extension setting reaches the port. Until
   that line lands, `planOriginate` computes the value and nothing consumes it.

## The sipd half (apps/sipd — NOT edited; spec for its owner)

On `rpc.sip.v1.originate`, given `callerIdNumber` (N), `callerIdName` (D), the trunk's configured
`sipDomain` (T) and `callerIdPresentation` (P, absent ⇒ `allowed`):

**Always, on every outbound trunk INVITE, regardless of P — this is the other half of P2-3.**
Emit `P-Asserted-Identity: "D" <sip:N@T>` (RFC 3325 §7; omit the display name when D is empty).
Most carriers authenticate the trunk's identity on PAI and treat `From` as display-only, so a trunk
that sends `From` alone has its tenant's chosen caller ID overwritten upstream. One PAI header, one
`sip:` URI; do not send a second `tel:` form unless a trunk option asks for it. PAI is only valid
inside a trust domain, so send it on trunk calls and never on a call leaving to an untrusted UA
(a registered device); strip any inbound PAI you do not trust before reusing it.

**When P = `restricted`:**

- `From: "Anonymous" <sip:anonymous@anonymous.invalid>;tag=…` — RFC 3323 §4.1.1.3. Literally that
  display name and that URI: `anonymous.invalid` is the reserved host, and a real domain here leaks the
  tenant. The local tag stays random as always.
- `P-Asserted-Identity` still carries the REAL `"D" <sip:N@T>` as above, so the carrier's own
  authorisation and any lawful-intercept path keep the identity. Withholding it from the network is
  not what CLIR means and would get the trunk rejected.
- `Privacy: id` — RFC 3323 §4.2. `id` is the correct token when the privacy is carried by PAI; it
  tells the trust-domain edge to strip PAI before the call leaves. Do not send `Privacy: user` (that
  asks the network to rewrite `From`, which we have already done) and never `Privacy: none`.
- `Contact` keeps the real signalling address — it is transport, is needed for in-dialog requests, and
  RFC 3323 does not anonymise it in this mode. `Remote-Party-ID` is legacy and is not sent.
- `sipDomain`: T is the trunk's configured domain and is used for the PAI URI and, when
  P = `allowed`, the `From` URI. When P = `restricted` the `From` host becomes `anonymous.invalid`
  and T appears ONLY in PAI. If a trunk has no `sipDomain`, PAI falls back to the trunk's proxy host
  — never to `anonymous.invalid`, which would make the asserted identity unroutable.

**When P = `allowed` or absent:** unchanged `From`, plus the always-on PAI. No `Privacy` header.

Refusal: an unknown enum value is a schema failure at decode and returns `bad_request` — the enum is
closed on the wire, unlike the engine-side override, which is a free-text channel variable.

## Verification (exact)

| Command                                                                 | Result                                                                                                                                                     |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @optimiq-voice/events run typecheck`                     | pass, 0 errors                                                                                                                                             |
| `pnpm --filter @optimiq-voice/events run test`                          | 399 pass, 12 skip, **1 fail** — `src/subjects.spec.ts:54` "pins the taxonomy from plan §3.5", a concurrent agent's new subject root; not mine, untouched   |
| `pnpm --filter @optimiq-voice/events run codegen` ×2                    | idempotent: `shasum` over every file in `packages/events-go` identical between runs, `git status --porcelain packages/events packages/events-go` identical |
| `pnpm --filter @optimiq-voice/engine run typecheck`                     | pass, 0 errors (the call-control.spec.ts errors seen mid-run were the concurrent agent's and were gone by the final run)                                   |
| `pnpm --filter @optimiq-voice/engine exec bun test src/media src/calls` | **599 pass, 0 fail**, 1587 expect(), 20 files                                                                                                              |
| `pnpm exec oxlint <my files>`                                           | exit 0, no diagnostics                                                                                                                                     |
| `pnpm exec oxfmt <my files>`                                            | exit 0, 31 files                                                                                                                                           |

No git state touched; no service restarted; `packages/routing`, `apps/api`, `apps/web`, `apps/sipd`
untouched.
