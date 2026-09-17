# recording-compliance — the contract every layer implements

One vocabulary, declared once in `packages/routing/src/recording-consent.ts` and mirrored (never
imported) where a package cannot depend on routing. Everything is ADDITIVE and OPTIONAL: an
artifact, an event or a row compiled before this exists must read exactly as it did.

## 1. Vocabulary — `packages/routing/src/recording-consent.ts` (new, exported from `index.ts`)

```ts
/** What a tenant asks of a call it records. */
export const RECORDING_CONSENT_POLICIES = [
	"none",
	"announce",
	"announce-and-require-keypress",
] as const;
export type RecordingConsentPolicy = (typeof RECORDING_CONSENT_POLICIES)[number];

/** What actually happened on one call. */
export const RECORDING_CONSENT_OUTCOMES = [
	"not-required",
	"announced",
	"accepted",
	"declined",
] as const;
export type RecordingConsentOutcome = (typeof RECORDING_CONSENT_OUTCOMES)[number];

/** How the outcome was reached. */
export const RECORDING_CONSENT_METHODS = ["none", "announcement", "keypress"] as const;
export type RecordingConsentMethod = (typeof RECORDING_CONSENT_METHODS)[number];

/** The record one call carries. `regions` names the jurisdictions that forced all-party treatment. */
export interface RecordingConsentRecord {
	readonly outcome: RecordingConsentOutcome;
	readonly method: RecordingConsentMethod;
	readonly policy: RecordingConsentPolicy;
	/** ISO 8601, stamped when the outcome was decided. */
	readonly at: string;
	/** Which parties heard the announcement. */
	readonly parties: readonly ("caller" | "callee")[];
	readonly regions?: readonly string[];
	readonly promptId?: string;
}

/**
 * All-party ("two-party") consent jurisdictions this platform treats as requiring both sides to be
 * told. ISO 3166-2 for US states, `EU` for the Union. A POLICY DEFAULT, not legal advice — see
 * `docs/recording-compliance.md`.
 */
export const DEFAULT_ALL_PARTY_REGIONS = [
	"US-CA",
	"US-DE",
	"US-FL",
	"US-IL",
	"US-MD",
	"US-MA",
	"US-MI",
	"US-MT",
	"US-NV",
	"US-NH",
	"US-OR",
	"US-PA",
	"US-WA",
	"EU",
] as const;
```

## 2. `packages/routing` — snapshot inputs

`RoutingSettingsInput` (`snapshot.ts`) gains, all optional, all with compiler defaults:

| field                          | type                             | default                                        |
| ------------------------------ | -------------------------------- | ---------------------------------------------- |
| `recordingConsentPolicy`       | `RecordingConsentPolicy \| null` | `"none"`                                       |
| `recordingConsentPromptId`     | `string \| null`                 | absent → engine plays the seeded system prompt |
| `recordingConsentAcceptDigit`  | `string \| null`                 | `"1"`                                          |
| `recordingConsentDeclineDigit` | `string \| null`                 | `"2"`                                          |
| `recordingAllPartyRegions`     | `readonly string[]`              | `DEFAULT_ALL_PARTY_REGIONS`                    |
| `recordingAutoPauseOnDtmf`     | `boolean \| null`                | `false`                                        |

Per-DID / per-inbound-route override (both optional, both `null` = "inherit the org"):
`PhoneNumberInput.recordingConsentPolicy?`, `.recordingConsentPromptId?`;
`InboundRouteInput.recordingConsentPolicy?`, `.recordingConsentPromptId?`.

Per-extension / per-queue PCI: `ExtensionInput.recordAutoPauseOnDtmf?: boolean | null`,
`QueueInput.recordAutoPauseOnDtmf?: boolean | null`.

## 3. `packages/routing` — compiled artifact (`artifact.ts`), no version bump

```ts
export interface CompiledRecordingPolicy {
	readonly consentPolicy: RecordingConsentPolicy;
	readonly consentPromptId?: string;
	readonly acceptDigit: string;
	readonly declineDigit: string;
	readonly allPartyRegions: readonly string[];
	readonly autoPauseOnDtmf: boolean;
}
```

- `CompiledRoutingSettings.recording?: CompiledRecordingPolicy` — absent only in an old artifact.
- `InboundDidDefault` and `InboundRule` gain `recordingConsentPolicy?: RecordingConsentPolicy` and
  `recordingConsentPromptId?: string`. Absent = inherit the org.
- `ExtensionPlanNode.recordAutoPauseOnDtmf?: boolean`, `QueuePlanNode.recordAutoPauseOnDtmf?: boolean`,
  `ExtensionIndexEntry.recordAutoPauseOnDtmf?: boolean`.
- A `recordingConsentPromptId` naming a prompt row that does not exist is a compile WARNING and the
  field is dropped (same rule every other prompt id follows).

## 4. `packages/events` — additive, optional only

- `channelRecordStartedDataSchema.consent?: recordingConsentSchema` (new exported schema mirroring
  `RecordingConsentRecord`; `parties` max 4, `regions` max 16).
- `cdrLegWriteDataSchema` (already `looseObject`) pins four nullish fields:
  `recordingConsent` (enum of outcomes), `recordingConsentMethod`, `recordingConsentAt` (iso),
  `recordingConsentRegions` (`string[]` max 16).
- Rebuild `packages/events` afterwards (`pnpm --filter @optimiq-voice/events run build`) — the api
  imports its `dist`.

## 5. Databases — additive migrations only

`packages/pbx-db`:

- `org_setting` needs nothing (settings are jsonb rows).
- `phone_number` + `inbound_route`: `recording_consent_policy text` (nullable, check against the
  three values), `recording_consent_prompt_id uuid` (FK → `prompt.id`, on delete set null).
- `extension` + `queue`: `record_auto_pause_on_dtmf boolean not null default false`.

`packages/cdr-db`:

- `recordings`: `consent jsonb` — the whole `RecordingConsentRecord`. Null = the row predates this or
  no consent was required. Same argument the `pauses` column records.
- `call_legs`: `recording_consent text`, `recording_consent_method text`,
  `recording_consent_at timestamptz`, `recording_consent_regions jsonb`. All nullable, no check that
  would reject an unknown future value on an append-only partitioned table.
- Generate with each package's `db:generate`; apply with `db:migrate`.

## 6. Engine — `apps/engine/src/calls` only

New `apps/engine/src/calls/recording-jurisdiction.ts`:

- `regionsForNumber(e164: string): readonly string[]` — `+1` → NANP NPA table → `US-XX`; other
  country codes → ISO-3166-1 alpha-2, plus `EU` when the country is an EU member.
- `requiresAllParty(numbers: readonly (string|undefined)[], allPartyRegions): readonly string[]` —
  the matched regions, empty when none.

New `apps/engine/src/calls/recording-consent.ts`:

- `resolveRecordingConsent(artifact, { didE164?, inboundRouteId?, callerIdNumber?, destinationNumber? })`
  → `{ policy, promptId?, acceptDigit, declineDigit, parties, regions }`. DID/route override beats the
  org; an all-party region match upgrades `parties` to BOTH sides and upgrades `none` → `announce`.

`CallControl.startRecording` (`call-control.ts`) runs the consent gate BEFORE any tap exists:

1. `policy === "none"` and no jurisdiction match → consent `not-required`, record as today.
2. `announce` → play the prompt to each party in `parties` (`media.play(mediaChannelId, …)` and, when
   the far side is known, `media.play(peerMediaChannelId, …)`) → outcome `announced`, method
   `announcement`. Outbound recorded calls therefore announce to the far end because the far end IS
   the peer leg.
3. `announce-and-require-keypress` → announce, then wait for the accept digit on the recorded party's
   leg (`signals.watch(legSignalKey(...))`, bounded by `consentKeypressTimeoutMs`, default 10 s).
   Accept digit → `accepted`. Decline digit or timeout → `declined`: **no recording is started**,
   `startRecording` returns a refusal naming the decline, and the consent record is kept on the leg
   so the CDR carries it.

- The record travels on `channel.record.started.consent` and, for every outcome including `declined`,
  onto the CDR leg via the orchestrator (`host.markConsent(leg, record)` → aggregate variables read by
  `cdr-leg.ts`).
- New settings on `CallControlSettings`: `consentKeypressTimeoutMs` (10 000), `consentPrompt`
  (`"sound:recording-consent"` — the seeded stem, used when the tenant names no prompt).

Auto-pause on DTMF (`channel-orchestrator.service.ts` `onDtmf`):

- when the leg (or its bridge peer) has a running, unpaused recording and the resolved policy says
  auto-pause, `control.pauseRecording(leg, true)` and arm/refresh a quiet-window timer
  (`recordingAutoResumeMs`, default 3 000) that resumes it. Every digit refreshes the window. Timers
  are cleared on leg teardown and on an explicit stop.
- Policy resolution at recording-start time: explicit `StartRecordingRequest.autoPauseOnDtmf`, else
  `artifact.extensionsByNumber[destination]?.recordAutoPauseOnDtmf`, else
  `artifact.settings.recording?.autoPauseOnDtmf`, else false.

## 7. API — `apps/api`

- `org-settings.catalog.ts`: six new `recordings`-category descriptors mirroring §2's org fields
  (`consentPolicy`, `consentPromptId`, `consentAcceptDigit`, `consentDeclineDigit`,
  `allPartyRegions`, `autoPauseOnDtmf`). All `scope: "organization"`; the category already writes
  under `recordings.configure`.
- `snapshot-loader.ts`: read them into `RoutingSettingsInput`; read the two new DID/route columns and
  the two new auto-pause columns.
- `system-media.ts`: seed a `recording-consent` stem (bump `SYSTEM_MEDIA_VERSION` to 2) so
  `sound:recording-consent` exists on a stock install, exactly like `vm-rec-name`.
- Recording writer: persist `consent` from `channel.record.started`; CDR writer: persist the four leg
  columns from `cdr.leg.write`.
- **Erasure**: `apps/api/src/cdr/erasure/` — `POST /api/v1/erasure/preview` and
  `POST /api/v1/erasure` with body `{ phoneNumber?: E164, extension?: string }` (exactly one).
  Permission `recordings.delete` (nothing new in the registry — `recordings.delete` is the nearest
  existing and already means "destroy recorded evidence"). Behaviour:
  - preview: counts of recordings, voicemail messages and CDR legs that WOULD be affected; changes
    nothing.
  - apply: object-before-row for every recording and voicemail message (delete the object, then
    tombstone/delete the row), then CDR PII hashing — `from_number`/`to_number` → `sha256:<hex>`
    truncated to the column, `from_name`/`to_name`/`sip_call_id`/`account_code`/`remote_media_address`
    → null, `raw` → null. Legs are KEPT so billing counts survive.
  - idempotent: a second apply finds nothing left and reports zeroes.
  - audited through the existing audit path with the action `recording.erasure`.

## 8. Web — `apps/web`

- `settings/recordings/page.tsx`: the consent policy select, prompt picker, digits, region list and
  the auto-pause toggle, beside retention. Same `RequirePermission recordings.configure` gate.
- A "Erase a party's data" panel on the same screen: number/extension input → preview → confirm.
  Gated on `recordings.delete`.
- `lib/pbx/contracts.ts` + `schemas.ts` mirrors for the new DID/route/extension/queue fields; the
  extension, queue, phone-number and inbound-route dialogs gain the controls.
- Recordings list shows the consent outcome per row.

## 9. Documentation

`docs/recording-compliance.md`: the region mapping table, what each policy does, and an explicit
"this is a configurable policy default, not legal advice; confirm your obligations with counsel".
