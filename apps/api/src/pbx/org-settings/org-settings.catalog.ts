import { z } from "zod/v4";
import { SETTING_VALUE_TYPES } from "@optimiq-voice/pbx-db";
import {
	DEFAULT_ALL_PARTY_REGIONS,
	RECORDING_CONSENT_POLICIES,
	UNVERIFIED_CALLER_ID_POLICIES,
} from "@optimiq-voice/routing";
import {
	SIP_PORT_SETTING,
	SIP_TRANSPORT_PREFERENCES,
	SIP_TRANSPORT_SETTING,
} from "../../provisioning/catalog/transport-preference";
import { e164 } from "../shared/dto";
import type { Permission } from "@optimiq-voice/auth";
import type { SettingValueType } from "@optimiq-voice/pbx-db";

/**
 * What `org_setting` and `user_setting` are allowed to hold, declared in code.
 *
 * ## The tables model a cascade, not a record
 *
 * `packages/pbx-db`'s `settings-schema.ts` states the design: platform defaults live in CODE, not
 * in a table, because "a default row nobody wrote is indistinguishable from a deliberate override,
 * and a code-owned default is versioned, typed and reviewable". The resolution order is
 * `code default → org_setting → user_setting` — all three levels real now that `user_setting` is
 * back and {@link resolveForUser} reads it, where for a long stretch this sentence described one
 * level and an aspiration — and the row is `(category, name, jsonb value, value_type)` — five
 * columns that can express anything, which is exactly the problem this file solves.
 *
 * A free-form `(category, name, value)` write endpoint has the failure mode `feature-codes.dto.ts`
 * records for its `params` bag, one level worse: a typo is accepted, saved, and read by nothing,
 * forever, while looking on screen exactly like a setting that works. So the settings this
 * platform actually reads are declared here — with a type, a default, and a sentence — and the
 * write path validates against the declaration.
 *
 * ## Uncatalogued rows are still writable, and that is deliberate
 *
 * The cascade is genuinely open-ended: `provision.repository.ts` reads whatever is in the
 * `provision` category and hands it to a device template, and a deployment's own tooling may keep
 * rows here that this codebase knows nothing about. Refusing those would turn a general-purpose
 * table into a closed enum and break a working feature.
 *
 * The rule is therefore: a **catalogued** `(category, name)` is validated against its schema and
 * its `valueType` is derived — a wrong-typed value is a 400, not a row nothing can read. An
 * **uncatalogued** pair is accepted with whatever `valueType` the caller declares. The API says
 * which is which through `GET /api/v1/org-settings/catalog`, so a form can render a checkbox for
 * the first and a JSON box for the second.
 */

export const NOTIFICATION_SETTINGS_CATEGORY = "notifications";

/**
 * The category the routing snapshot reads whole.
 *
 * Declared here rather than in `routing/snapshot-loader.ts`, which re-exports it: a category name is
 * a catalogue fact, and having the catalogue import it from its own reader made a module cycle whose
 * failure mode was a temporal-dead-zone `ReferenceError` at import time. See the note at the
 * re-export.
 */
export const ROUTING_SETTINGS_CATEGORY = "routing";

/**
 * The category `provision.repository.ts` already reads whole and hands to a device template.
 *
 * Catalogued for the first time here, and only two of its keys are. That is the rule this file's
 * header states: the `provision` category is genuinely open-ended — a vendor parameter this
 * codebase has never heard of is a legitimate row — so catalogue only the keys the PLATFORM reads,
 * and let the rest through with whatever `valueType` the caller declares.
 */
export const PROVISION_SETTINGS_CATEGORY = "provision";

/**
 * Which cascade level may override a setting below the organization.
 *
 * An enum naming the LEVEL rather than a `userScoped` boolean, for two reasons. First, the
 * vocabulary already exists: `provisioning/catalog/cascade.ts` names its levels
 * (`model → organization → profile → device`), and this cascade's levels deserve the same
 * spelling — `scope: "user"` reads as "the user level may override this", where `userScoped: true`
 * reads as a fact about visibility and invites the misreading "only a user may see it". Second, a
 * boolean is a door that only opens once; if a level ever lands between the two (a team, a site),
 * an enum grows a member and a boolean becomes a migration.
 */
export const SETTING_SCOPES = ["organization", "user"] as const;
export type SettingScope = (typeof SETTING_SCOPES)[number];

export interface SettingDescriptor {
	readonly category: string;
	/** camelCase, matching the names `readRoutingSettings` already reads. */
	readonly name: string;
	readonly valueType: SettingValueType;
	readonly label: string;
	readonly description: string;
	/** What a write must satisfy. Also what `GET …/categories/:category` coerces a row through. */
	readonly schema: z.ZodType;
	/** The platform default — the first level of the cascade, and why a tenant needs no rows. */
	readonly defaultValue: unknown;
	/**
	 * The deepest level that may override this setting. `organization` — the default — means the
	 * cascade stops at `org_setting` and {@link resolveForUser} IGNORES any `user_setting` row
	 * with this name. `user` is a claim with teeth: it is what lets `PATCH /org-settings/me/…`
	 * accept the name, and it is only ever given to settings that are genuinely one person's
	 * presentation preference rather than anyone's policy.
	 */
	readonly scope: SettingScope;
}

function descriptor(
	input: Omit<SettingDescriptor, "scope"> & { readonly scope?: SettingScope },
): SettingDescriptor {
	return { ...input, scope: input.scope ?? "organization" };
}

/**
 * The notification settings — the org-level half of voicemail-to-email and anything else this
 * platform mails on a tenant's behalf.
 *
 * ## Why the org has a switch when the mailbox already has one
 *
 * `voicemail_box.email_mode` (`none` / `notify` / `attach`) is the per-mailbox decision and it
 * stays authoritative: a box set to `none` is never emailed regardless of what is here. This is
 * the ORGANIZATION's kill switch, and it exists because the two answer different questions. "Does
 * this mailbox want email?" is a user preference set on one row. "May this tenant send voicemail
 * content to external mailboxes at all?" is a policy — the answer changes for a whole organization
 * when its compliance posture changes, and expressing that as a bulk edit of every `voicemail_box`
 * row would be a migration rather than a setting, with no record of what the policy was.
 *
 * Both must be on. The org switch can only ever narrow.
 */
export const NOTIFICATION_SETTINGS: readonly SettingDescriptor[] = [
	/**
	 * Deliberately NOT user-scoped, while its two `include*` siblings below are. The user answer
	 * to "do I want voicemail email at all?" already has a home: `voicemail_box.email_mode`
	 * (`none` / `notify` / `attach`), a per-mailbox column the delivery path reads first. A
	 * `user_setting` row for the same question would be a second source of truth, and the two
	 * would disagree the first time somebody changed one through a screen that did not know about
	 * the other. This org-level switch stays a policy — the tenant's kill switch — and the
	 * per-person switch stays on the mailbox.
	 */
	descriptor({
		category: NOTIFICATION_SETTINGS_CATEGORY,
		name: "voicemailToEmailEnabled",
		valueType: "boolean",
		label: "Voicemail to email",
		description:
			"Send a message to a mailbox's email address when a caller leaves a voicemail. A " +
			"mailbox whose delivery mode is 'none' is never emailed regardless of this setting.",
		schema: z.boolean(),
		defaultValue: true,
	}),
	/**
	 * The first of the two user-scoped settings in the catalogue, and the shape of the argument
	 * for both: whether MY notification carries a playback link is a presentation preference with
	 * no per-mailbox column, no compliance dimension (the link is signed and expiring either way —
	 * the org decides whether audio may leave at all with `voicemailToEmailEnabled`), and no
	 * reader other than the mail renderer. Nothing about one person's taste here narrows or widens
	 * anybody else's mail.
	 */
	descriptor({
		category: NOTIFICATION_SETTINGS_CATEGORY,
		name: "voicemailToEmailIncludeLink",
		valueType: "boolean",
		label: "Include a playback link",
		description:
			"Include a signed, expiring link to the recording in the notification. The link carries " +
			"the message id inside the signature and expires within minutes.",
		schema: z.boolean(),
		defaultValue: true,
		scope: "user",
	}),
	/** User-scoped on the same argument as `voicemailToEmailIncludeLink` above. */
	descriptor({
		category: NOTIFICATION_SETTINGS_CATEGORY,
		name: "voicemailToEmailIncludeTranscription",
		valueType: "boolean",
		label: "Include the transcription",
		description:
			"Include the transcription in the notification when the mailbox has transcription " +
			"enabled and one is available.",
		schema: z.boolean(),
		defaultValue: true,
		scope: "user",
	}),
	descriptor({
		category: NOTIFICATION_SETTINGS_CATEGORY,
		name: "fromName",
		valueType: "string",
		label: "Notification from name",
		description:
			"The display name shown on notifications this organization sends. The envelope sender " +
			"address itself is platform configuration (MAIL_FROM) and is not settable per tenant.",
		schema: z.string().trim().min(1).max(128).nullable(),
		defaultValue: null,
	}),
	descriptor({
		category: NOTIFICATION_SETTINGS_CATEGORY,
		name: "replyTo",
		valueType: "string",
		label: "Notification reply-to",
		description: "Where a reply to a notification goes. Leave empty to use the platform default.",
		schema: z.email().max(254).nullable(),
		defaultValue: null,
	}),
	/**
	 * The Kari's Law "central location".
	 *
	 * 47 U.S.C. §623(b) / 47 CFR §9.16 require an MLTS to notify a central location — a front desk,
	 * a security office, a distribution list — when somebody dials 911 from it, contemporaneously
	 * with the call and without anyone having to configure it per call. This list IS that central
	 * location, expressed the way a tenant can actually maintain it.
	 *
	 * Three properties are deliberate:
	 *
	 * - **The default is empty, and empty means nobody is notified.** There is no defensible
	 *   platform-wide default recipient — mailing the account owner would send a security incident
	 *   to whoever happened to sign up — so an unconfigured tenant gets a WARN log naming the
	 *   setting rather than a message to a guess. See `emergency-notification.service.ts`.
	 * - **There is no enable/disable flag beside it.** A boolean that can be false while addresses
	 *   are configured is a switch somebody turns off during a mail storm and never turns back on,
	 *   and the thing it disables is a legal obligation. The list's emptiness is the only off.
	 * - **`voicemailToEmailEnabled` does NOT gate it.** That switch is a privacy policy about
	 *   recorded audio leaving the platform; this is a life-safety notification carrying no
	 *   recording. Coupling them would let a compliance decision about voicemail silently disable
	 *   Kari's Law.
	 */
	descriptor({
		category: NOTIFICATION_SETTINGS_CATEGORY,
		name: "emergencyNotificationEmails",
		valueType: "array",
		label: "Emergency notification recipients",
		description:
			"Addresses notified the moment somebody dials an emergency number from this " +
			"organization (Kari's Law, 47 CFR §9.16). Empty means nobody is notified — the platform " +
			"has no safe default for who a tenant's front desk is.",
		schema: z.array(z.email().max(254)).max(32),
		defaultValue: [],
	}),
];

/**
 * The routing settings, restated as catalogue entries.
 *
 * The names and their meanings are `readRoutingSettings`'s — this adds nothing to what the
 * compiler reads and MUST NOT: a name here that the loader does not read is a setting a user can
 * save and no call will ever observe. They are catalogued so the same validated write path covers
 * them, because before this resource existed they had no write path at all.
 *
 * None of them is user-scoped, and none can become so by accident of a copied `scope: "user"`
 * line: the compiler reads these into ONE artifact per tenant, so a per-user override would be a
 * value the snapshot loader never sees — saved, shown, and observed by no call.
 */
export const ROUTING_SETTINGS: readonly SettingDescriptor[] = [
	descriptor({
		category: ROUTING_SETTINGS_CATEGORY,
		name: "defaultTimezone",
		valueType: "string",
		label: "Default time zone",
		description: "IANA zone a time condition falls back to when it does not carry one.",
		schema: z.string().trim().min(1).max(64),
		defaultValue: "UTC",
	}),
	descriptor({
		category: ROUTING_SETTINGS_CATEGORY,
		name: "voicemailPrefix",
		valueType: "string",
		label: "Voicemail transfer prefix",
		description:
			"Dial prefix that sends a call straight to a mailbox's greeting, e.g. *99 + extension. " +
			"Empty disables the internal voicemail-prefix table.",
		schema: z.string().trim().min(1).max(16).nullable(),
		defaultValue: null,
	}),
	descriptor({
		category: ROUTING_SETTINGS_CATEGORY,
		name: "voicemailCheckPrefix",
		valueType: "string",
		label: "Voicemail check prefix",
		description: "Prefix that logs a caller into their own mailbox, e.g. *98 + mailbox number.",
		schema: z.string().trim().min(1).max(16).nullable(),
		defaultValue: null,
	}),
	descriptor({
		category: ROUTING_SETTINGS_CATEGORY,
		name: "outboundCallerIdNumber",
		valueType: "string",
		label: "Organization outbound caller id",
		description:
			"Used when neither the outbound route nor the extension supplies a caller id number.",
		// The shared `e164`, not the fourth hand-copied regex: this one had drifted to 19 digits and
		// no normalisation, so the same number a DID form accepted was refused here.
		schema: e164.nullable(),
		defaultValue: null,
	}),
	descriptor({
		category: ROUTING_SETTINGS_CATEGORY,
		name: "outboundCallerIdName",
		valueType: "string",
		label: "Organization outbound caller name",
		description: "Display name presented outbound when nothing more specific supplies one.",
		schema: z.string().trim().min(1).max(64).nullable(),
		defaultValue: null,
	}),
	descriptor({
		category: ROUTING_SETTINGS_CATEGORY,
		name: "defaultCallingCode",
		valueType: "string",
		label: "Default country calling code",
		description:
			"The calling code this organization's national numbers belong to — 1 for NANP, 44 for the " +
			"UK. It lets the routing compiler canonicalise a DID or caller id stored as a bare " +
			"national number. Empty means a bare national number is reported rather than guessed at.",
		// Digits with an optional leading `+`, which is what a person types. `e164-ingest.ts` strips
		// the plus; the bound is the four digits the ITU assigns.
		schema: z
			.string()
			.trim()
			.regex(/^\+?[1-9]\d{0,3}$/u, "must be a country calling code, e.g. 1 or +44")
			.nullable(),
		defaultValue: null,
	}),
	descriptor({
		category: ROUTING_SETTINGS_CATEGORY,
		name: "outboundEnabled",
		valueType: "boolean",
		label: "Outbound calling",
		description: "Organization-wide kill switch for reaching outbound routes at all.",
		schema: z.boolean(),
		defaultValue: true,
	}),
	descriptor({
		category: ROUTING_SETTINGS_CATEGORY,
		name: "trunkContinueOnCauses",
		valueType: "array",
		label: "Retryable hangup causes",
		description:
			"Hangup causes that let an outbound dial continue to the next trunk. Never 'all causes' " +
			"— retrying a CALL_REJECTED on every trunk is how toll-fraud loops start.",
		schema: z.array(z.string().trim().min(1).max(64)).max(32),
		defaultValue: [],
	}),
	descriptor({
		category: ROUTING_SETTINGS_CATEGORY,
		name: "emergencyNumbers",
		valueType: "array",
		label: "Additional emergency numbers",
		description:
			"Emergency dial strings recognised in addition to the compiled-in NANP set. Additive " +
			"only: no setting can remove 911.",
		schema: z.array(z.string().trim().min(1).max(16)).max(32),
		defaultValue: [],
	}),
];

/**
 * The two provisioning settings the platform itself reads.
 *
 * They are the fleet's migration path onto SIP-TLS, and they are catalogued rather than left as
 * free-form `provision` rows for a specific reason: a typo in `sipTransport` is a fleet that keeps
 * registering in the clear while the settings screen shows TLS selected. A catalogued key is
 * validated on write and a wrong value is a 400.
 *
 * See `provisioning/catalog/transport-preference.ts` for why the default is `inherit` rather than
 * `udp`, why the org level overrides the per-line column rather than defaulting it, and why the
 * port is a separate setting instead of being inferred from the transport.
 */
export const PROVISION_SETTINGS: readonly SettingDescriptor[] = [
	descriptor({
		category: PROVISION_SETTINGS_CATEGORY,
		name: SIP_TRANSPORT_SETTING,
		valueType: "string",
		label: "Phone SIP transport",
		description:
			"Which transport provisioned phones are told to use. 'inherit' leaves each device line " +
			"at its own setting and is what every deployment did before this existed — change it only " +
			"once the SIP edge answers on that transport, because a phone provisioned onto a listener " +
			"that is not there simply stops registering. 'tls' usually needs the SIP port set to 5061 " +
			"as well; it is the setting beside this one.",
		schema: z.enum(SIP_TRANSPORT_PREFERENCES),
		defaultValue: "inherit",
	}),
	descriptor({
		category: PROVISION_SETTINGS_CATEGORY,
		name: SIP_PORT_SETTING,
		valueType: "number",
		label: "Phone SIP port",
		description:
			"Overrides the port on every provisioned line. Leave empty to use each line's own port. " +
			"Deliberately not inferred from the transport: a deployment that terminates TLS anywhere " +
			"other than 5061 would be silently misprovisioned by a rule that guessed.",
		schema: z.int().min(1).max(65_535).nullable(),
		defaultValue: null,
	}),
];

export const SIP_SETTINGS: readonly SettingDescriptor[] = [
	descriptor({
		category: "sip",
		name: "realm",
		valueType: "string",
		label: "Organization SIP domain",
		description:
			"The unique domain used by this organization's SIP phones to register and authenticate.",
		schema: z
			.string()
			.trim()
			.toLowerCase()
			.min(1)
			.max(253)
			.refine(
				(value) =>
					value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)),
				"Enter a valid SIP domain without a scheme, port or trailing dot.",
			)
			.nullable(),
		defaultValue: null,
	}),
	descriptor({
		category: "sip",
		name: "requireSrtpForTlsPhones",
		valueType: "boolean",
		label: "Require SRTP for TLS phones",
		description:
			"A device registered over TLS or WSS must negotiate SDES-SRTP; a leg that cannot is " +
			"refused rather than carried as plain RTP. Phones registered over UDP or TCP are " +
			"unaffected, and neither are trunks, which carry their own per-carrier policy.",
		schema: z.boolean(),
		// `false`, and the default is the decision: turning this on refuses calls for any handset
		// that speaks no SRTP, which for a tenant with older phones is an outage rather than a
		// hardening. It has to be a tenant saying yes, not a release deciding for them.
		defaultValue: false,
	}),
];

export const RECORDING_SETTINGS_CATEGORY = "recordings";
export const RECORDING_RETENTION_SETTING = "retentionDays";

/**
 * The voicemail half of the same posture.
 *
 * Deliberately the SAME vocabulary and the SAME bounds as {@link RECORDING_RETENTION_SETTING}
 * beside it — days, `0` means keep for ever, ten years at the top — because the failure mode of
 * two retention settings on one screen is an administrator who reads the second one in the first
 * one's units. There is no platform env behind this one to fall back to (a voicemail is a tenant's
 * mailbox, not a platform artefact), so an absent row means the catalogue default and the
 * catalogue default is "keep indefinitely": a release that shipped a sweeper must not begin
 * destroying messages nobody asked it to destroy.
 */
export const VOICEMAIL_RETENTION_SETTING = "voicemailRetentionDays";

/**
 * The disclosure half of the recording posture — what the parties are TOLD, as against how long
 * what they said is kept.
 *
 * Six names rather than one object-valued setting, on the rule this catalogue already follows for
 * the transport pair and the two caller-id fields: a setting is a value a form renders and a write
 * validates, and folding six of them into one JSON blob would give a screen one text box and a
 * write path one schema error for six different mistakes. The engine reassembles them into a
 * single `CompiledRecordingPolicy` at compile time, where they belong together.
 */
export const RECORDING_CONSENT_POLICY_SETTING = "consentPolicy";
export const RECORDING_CONSENT_PROMPT_SETTING = "consentPromptId";
export const RECORDING_CONSENT_ACCEPT_DIGIT_SETTING = "consentAcceptDigit";
export const RECORDING_CONSENT_DECLINE_DIGIT_SETTING = "consentDeclineDigit";
export const RECORDING_ALL_PARTY_REGIONS_SETTING = "allPartyRegions";
export const RECORDING_AUTO_PAUSE_SETTING = "autoPauseOnDtmf";

/**
 * The recording policy the tenant may set for itself.
 *
 * Two settings, one per recorded artefact class, and the first's default is chosen to be
 * INDISTINGUISHABLE from the platform env's:
 * `CDR_RECORDING_RETENTION_DAYS` says `0` means keep for ever, so this says exactly the same
 * thing with exactly the same bounds — two vocabularies for one number is how a tenant sets "30"
 * and gets a month while the operator reads "30" and expects a fortnight. Organization-scoped and
 * NEVER user-scoped: retention of recorded calls is a compliance posture, the same class of
 * decision as `voicemailToEmailEnabled`'s kill switch, and no individual's preference can shorten
 * or extend how long the organization keeps evidence.
 *
 * How the value reaches the recording write path — which lives in the CDR area, over a different
 * database — is `recording-retention-policy.service.ts`'s story.
 */
export const RECORDING_SETTINGS: readonly SettingDescriptor[] = [
	descriptor({
		category: RECORDING_SETTINGS_CATEGORY,
		name: RECORDING_RETENTION_SETTING,
		valueType: "number",
		label: "Recording retention (days)",
		description:
			"How many days a call recording is kept before it is purged. 0 keeps recordings " +
			"indefinitely. The window is stamped when a recording is written; changing it never " +
			"re-stamps recordings that already exist.",
		schema: z.int().min(0).max(3_650),
		defaultValue: 0,
	}),
	descriptor({
		category: RECORDING_SETTINGS_CATEGORY,
		name: VOICEMAIL_RETENTION_SETTING,
		valueType: "number",
		label: "Voicemail retention (days)",
		description:
			"How many days a voicemail message is kept before it is purged. 0 keeps messages " +
			"indefinitely. The window is evaluated against the message's received date on every " +
			"sweep, so shortening it purges messages that are already older than the new window.",
		schema: z.int().min(0).max(3_650),
		defaultValue: 0,
	}),
	/**
	 * What the tenant tells the people on a recorded call, before it starts recording them.
	 *
	 * The default is `none` and that is the only defensible default: this platform cannot know a
	 * tenant's obligations, and a release that started announcing on every recorded call would put
	 * a prompt in front of estates that have their disclosure elsewhere — in a contract, in an IVR
	 * greeting the tenant already wrote, in a jurisdiction that does not ask for one. `none` is
	 * therefore "say nothing HERE", never "consent does not apply", and it is deliberately not the
	 * end of the story: {@link RECORDING_ALL_PARTY_REGIONS_SETTING} below can still upgrade a
	 * particular call to an announcement, because the jurisdictions that require both parties to be
	 * told are exactly the ones where silence is the failure.
	 *
	 * `announce-and-require-keypress` is the strong form and it has teeth: a party who declines
	 * stops the recording from starting at all, and the decline is what the CDR records. A setting
	 * that announced a requirement and then recorded anyway would be worse than no setting.
	 */
	descriptor({
		category: RECORDING_SETTINGS_CATEGORY,
		name: RECORDING_CONSENT_POLICY_SETTING,
		valueType: "string",
		label: "Recording disclosure",
		description:
			"What the parties to a recorded call are told before recording starts. 'none' says " +
			"nothing; 'announce' plays the disclosure prompt; 'announce-and-require-keypress' plays " +
			"it and waits for the accept digit, and a party who declines is not recorded. A DID or " +
			"inbound route may override this for the calls that arrive on it.",
		schema: z.enum(RECORDING_CONSENT_POLICIES),
		defaultValue: "none",
	}),
	/**
	 * The tenant's own disclosure recording, when the seeded one will not do.
	 *
	 * A `prompt` row id, which is how every other configurable announcement on this platform is
	 * named (`greetingPromptId`, `invalidPromptId`, and the rest) — not a media URI, because the
	 * key is a key and only the reader knows where the store is mounted. Absent means the engine
	 * plays the seeded `recording-consent` system prompt, so a tenant who switches disclosure on
	 * gets a working announcement on the first call rather than silence and a note in the log.
	 */
	descriptor({
		category: RECORDING_SETTINGS_CATEGORY,
		name: RECORDING_CONSENT_PROMPT_SETTING,
		valueType: "string",
		label: "Disclosure prompt",
		description:
			"The prompt played as the recording disclosure. Leave empty to use the built-in " +
			"announcement.",
		schema: z.uuid().nullable(),
		defaultValue: null,
	}),
	/**
	 * The two digits the keypress form listens for.
	 *
	 * Configurable rather than fixed at `1` and `2` because the disclosure prompt is the tenant's
	 * and the digits it names have to be the digits the switch honours — a prompt that says "press
	 * 9 to consent" against a hard-coded `1` is a tenant recording people who believe they
	 * declined. One character each, and the accept and decline digits are validated as different
	 * from one another where they are read, not here: a catalogue entry validates its own value and
	 * cannot see its sibling's.
	 */
	descriptor({
		category: RECORDING_SETTINGS_CATEGORY,
		name: RECORDING_CONSENT_ACCEPT_DIGIT_SETTING,
		valueType: "string",
		label: "Consent accept digit",
		description: "The digit a party presses to consent to being recorded.",
		schema: z
			.string()
			.trim()
			.regex(/^[0-9*#]$/u, "must be a single DTMF digit"),
		defaultValue: "1",
	}),
	descriptor({
		category: RECORDING_SETTINGS_CATEGORY,
		name: RECORDING_CONSENT_DECLINE_DIGIT_SETTING,
		valueType: "string",
		label: "Consent decline digit",
		description:
			"The digit a party presses to refuse being recorded. The recording is not started, and " +
			"the refusal is written to the call record.",
		schema: z
			.string()
			.trim()
			.regex(/^[0-9*#]$/u, "must be a single DTMF digit"),
		defaultValue: "2",
	}),
	/**
	 * The jurisdictions this organization treats as requiring EVERY party to be told.
	 *
	 * A list rather than a boolean, and a POLICY DEFAULT rather than a legal rule — the platform
	 * ships the all-party US states and the EU as {@link DEFAULT_ALL_PARTY_REGIONS} because a
	 * default of "nowhere" would silently give every tenant the weakest posture, and a default of
	 * "everywhere" would put a prompt on every call in the estate. It is editable precisely because
	 * this is not legal advice: a tenant whose counsel reads a state differently changes the list,
	 * and `docs/recording-compliance.md` says so in as many words.
	 *
	 * A call matches when its caller id OR its destination resolves into one of these regions, at
	 * which point both sides are announced to and a policy of `none` is upgraded to `announce`. The
	 * resolution is E.164 → region and it is approximate by construction: numbers are portable, so
	 * an area code no longer proves where a person is standing. That is stated where the mapping
	 * lives (`apps/engine/src/calls/recording-jurisdiction.ts`) rather than hidden behind a switch
	 * that looks exact.
	 */
	descriptor({
		category: RECORDING_SETTINGS_CATEGORY,
		name: RECORDING_ALL_PARTY_REGIONS_SETTING,
		valueType: "array",
		label: "All-party consent regions",
		description:
			"Regions where every party to a call must be told it is recorded. A call whose caller " +
			"id or destination resolves into one of them is announced to on both sides, even when " +
			"the disclosure policy above is 'none'. ISO 3166 codes; 'EU' covers the Union. This is " +
			"a configurable default, not legal advice.",
		schema: z.array(z.string().trim().min(2).max(8)).max(64),
		defaultValue: [...DEFAULT_ALL_PARTY_REGIONS],
	}),
	/**
	 * PCI DSS 4.0.1's preference, expressed as a switch: do not capture the card number at all.
	 *
	 * The standard favours PREVENTING capture over asking an agent to remember to pause, and this
	 * is that preference implemented — the recorder pauses on the first DTMF digit and resumes
	 * after a quiet window, so a caller reading a PAN into the keypad leaves silence in the object
	 * whether or not the agent touched anything. The manual pause stays exactly as it was; this is
	 * the backstop under it, not a replacement for it.
	 *
	 * Off by default, because auto-pausing on DTMF is wrong for the estates that record IVR
	 * navigation deliberately, and a release that turned it on would put unexplained gaps in their
	 * evidence. An extension or a queue may turn it on for itself where the card entry actually
	 * happens.
	 */
	descriptor({
		category: RECORDING_SETTINGS_CATEGORY,
		name: RECORDING_AUTO_PAUSE_SETTING,
		valueType: "boolean",
		label: "Pause recording during keypad entry",
		description:
			"Pause the recorder while a caller is pressing keys, and resume it once they stop, so " +
			"card details entered on the keypad are not captured even when the agent forgets to " +
			"pause. Individual extensions and queues can turn this on for themselves.",
		schema: z.boolean(),
		defaultValue: false,
	}),
];

/**
 * The category holding what a tenant may PRESENT, and whether it may originate at all.
 *
 * Its own category rather than two more entries under `routing`, because the two questions have
 * different readers and different audiences. A routing setting answers "where does this call go";
 * these answer "may this call be placed, and what do we tell the downstream carrier about who is
 * placing it" — the STIR/SHAKEN attestation question the FCC's April 2026 FNPRM turns into an
 * obligation on the originating provider. Compiled by `compliance/attestation/attestation-policy.service.ts`
 * into a `CompiledAttestationPolicy` and by the routing compiler into the same shape.
 */
export const COMPLIANCE_SETTINGS_CATEGORY = "compliance";

/**
 * The two levers a tenant has over its own outbound compliance posture.
 *
 * Both default to the permissive answer, and that is a deliberate, temporary position rather than a
 * recommendation. Turning either on for an existing deployment would stop calls that are working
 * today — an operator whose customers have never filed a KYC file would take their whole platform
 * off the air by upgrading — so the defaults preserve behaviour and the migration is an operator
 * decision made per tenant, with a screen that says what it will break.
 */
export const COMPLIANCE_SETTINGS: readonly SettingDescriptor[] = [
	descriptor({
		category: COMPLIANCE_SETTINGS_CATEGORY,
		name: "unverifiedCallerIdPolicy",
		valueType: "string",
		label: "Unverified caller id",
		description:
			"What happens to an outbound call presenting a caller id with no right-to-use record — " +
			"neither one of this organization's own numbers nor a verified caller id. 'allow' places " +
			"the call and attests it C, which is honest but is the attestation carriers filter on. " +
			"'replace' substitutes the organization's main number and attests A, so the call connects " +
			"under an identity we can stand behind. 'refuse' rejects the call outright.",
		schema: z.enum(UNVERIFIED_CALLER_ID_POLICIES),
		defaultValue: "allow",
	}),
	descriptor({
		category: COMPLIANCE_SETTINGS_CATEGORY,
		name: "requireKycForOutbound",
		valueType: "boolean",
		label: "Require an approved KYC file for outbound PSTN",
		description:
			"Blocks outbound calls to the public network until this organization's know-your-customer " +
			"file has been approved by a platform reviewer. Internal calls, and emergency calls, are " +
			"never blocked by it.",
		schema: z.boolean(),
		defaultValue: false,
	}),
];

/** Every catalogued setting, in one list. */
export const SETTING_CATALOG: readonly SettingDescriptor[] = [
	...SIP_SETTINGS,
	...NOTIFICATION_SETTINGS,
	...ROUTING_SETTINGS,
	...PROVISION_SETTINGS,
	...RECORDING_SETTINGS,
	...COMPLIANCE_SETTINGS,
];

/**
 * Per-category permission overrides for the category read/write routes.
 *
 * `@RequirePermissions` on the controller stays the FLOOR (`settings.read` / `settings.write`),
 * because a decorator is static metadata and the category is a path parameter — the same
 * reasoning `queue-agent-session.service.ts` records for its row-dependent rule. This map is the
 * second check, consulted in the service against `session.permissions` with `hasPermission`.
 *
 * `recordings` is the entry that closes a debt: `recordings.configure` has existed in the
 * registry since it was declared ("Set always-on, on-demand, pause-and-mask and retention rules")
 * and enforced nothing, while `settings.write` — held by every role that manages ordinary tenant
 * configuration — would have let anyone with the settings screen shorten the organization's
 * evidence window. Reading the window stays `settings.read`: the retention policy is not itself
 * sensitive, and a settings screen that cannot show the current window cannot explain what
 * `recordings.configure` would change.
 */
export const CATEGORY_PERMISSIONS: Partial<
	Record<string, { readonly read: Permission; readonly write: Permission }>
> = {
	[RECORDING_SETTINGS_CATEGORY]: { read: "settings.read", write: "recordings.configure" },
};

/** The permissions guarding one category — the override, or the settings pair every route floors on. */
export function categoryPermissions(category: string): {
	readonly read: Permission;
	readonly write: Permission;
} {
	return CATEGORY_PERMISSIONS[category] ?? { read: "settings.read", write: "settings.write" };
}

const BY_KEY = new Map(SETTING_CATALOG.map((entry) => [`${entry.category} ${entry.name}`, entry]));

/** The catalogued categories, in catalogue order. */
export const CATALOGUED_CATEGORIES: readonly string[] = [
	...new Set(SETTING_CATALOG.map((entry) => entry.category)),
];

export function findSetting(category: string, name: string): SettingDescriptor | undefined {
	return BY_KEY.get(`${category} ${name}`);
}

export function settingsInCategory(category: string): readonly SettingDescriptor[] {
	return SETTING_CATALOG.filter((entry) => entry.category === category);
}

/** The settings in one category that the user level may override. */
export function userScopedSettingsInCategory(category: string): readonly SettingDescriptor[] {
	return settingsInCategory(category).filter((entry) => entry.scope === "user");
}

/** The categories with at least one user-scoped setting — what `GET …/me` iterates. */
export const USER_SCOPED_CATEGORIES: readonly string[] = [
	...new Set(
		SETTING_CATALOG.filter((entry) => entry.scope === "user").map((entry) => entry.category),
	),
];

/** Whether a string is one of the five `value_type` values the column accepts. */
export function isSettingValueType(value: string): value is SettingValueType {
	return (SETTING_VALUE_TYPES as readonly string[]).includes(value);
}

/**
 * The effective value of every setting in a category: the code default, overlaid by the rows.
 *
 * A DISABLED row is treated as absent, which is what the cascade means by `enabled` and what
 * `readRoutingSettings` already does — one rule, stated once, so "why is my setting not taking
 * effect?" has the same answer everywhere.
 *
 * A row whose stored value no longer satisfies its schema (the catalogue tightened, or the row
 * predates it) falls back to the default rather than propagating a value the reader cannot use.
 * Pure, so this is directly testable without a database.
 */
export function resolveCategory(
	category: string,
	rows: readonly {
		readonly name: string;
		readonly value: unknown;
		readonly enabled: boolean;
	}[],
): Record<string, unknown> {
	const stored = new Map(rows.filter((row) => row.enabled).map((row) => [row.name, row.value]));
	const resolved: Record<string, unknown> = {};
	for (const entry of settingsInCategory(category)) {
		if (!stored.has(entry.name)) {
			resolved[entry.name] = entry.defaultValue;
			continue;
		}
		const parsed = entry.schema.safeParse(stored.get(entry.name));
		resolved[entry.name] = parsed.success ? parsed.data : entry.defaultValue;
	}
	return resolved;
}

/** The row shape both resolvers take: what the two settings tables have in common. */
export interface SettingRowInput {
	readonly name: string;
	readonly value: unknown;
	readonly enabled: boolean;
}

/**
 * The whole cascade for one person: `code default → org_setting → user_setting`.
 *
 * Built ON {@link resolveCategory} rather than beside it, so the first two levels can never
 * disagree between the two resolvers — the org half of this answer IS `resolveCategory`'s answer,
 * and this function only decides what the third level may do to it. Three rules, each the same
 * shape as one the cascade already has:
 *
 * - A user row for a setting the catalogue does NOT mark user-scoped is **ignored, not an
 *   error** — a catalogue can tighten (a setting demoted from `user` to `organization` scope),
 *   and the rows written under the old catalogue must degrade to the organization's answer
 *   rather than break every read. The same reason `resolveCategory` ignores an uncatalogued name.
 * - A **disabled row is absent**, exactly as at the organization level — one rule, stated once,
 *   so "why is my preference not taking effect?" has the same answer as the org question.
 * - A user value that no longer satisfies its schema falls back to the level ABOVE it — the
 *   organization's resolution, not the code default, because the org level was valid and is what
 *   this person would see with no override at all.
 *
 * Pure, like `resolveCategory` and `provisioning/catalog/cascade.ts`'s `resolveSettings`, so the
 * rule table is directly testable without a database. No `explainSettings`-style provenance
 * function yet, deliberately: `cascade.ts` only grew one for a UI panel that needed it, and no
 * caller needs it here — the preferences screen shows the inherited value by reading the org
 * category, which it already can.
 */
export function resolveForUser(
	category: string,
	orgRows: readonly SettingRowInput[],
	userRows: readonly SettingRowInput[],
): Record<string, unknown> {
	const resolved = resolveCategory(category, orgRows);
	const stored = new Map(userRows.filter((row) => row.enabled).map((row) => [row.name, row.value]));
	for (const entry of userScopedSettingsInCategory(category)) {
		if (!stored.has(entry.name)) {
			continue;
		}
		const parsed = entry.schema.safeParse(stored.get(entry.name));
		if (parsed.success) {
			resolved[entry.name] = parsed.data;
		}
	}
	return resolved;
}

/** The catalogue as a client reads it: no zod, one entry per setting. */
export interface WireSettingDescriptor {
	readonly category: string;
	readonly name: string;
	readonly valueType: SettingValueType;
	readonly label: string;
	readonly description: string;
	readonly defaultValue: unknown;
	/** On the wire so a preferences screen knows which settings `PATCH …/me` will accept. */
	readonly scope: SettingScope;
}

export function toWireCatalog(): readonly WireSettingDescriptor[] {
	return SETTING_CATALOG.map((entry) => ({
		category: entry.category,
		name: entry.name,
		valueType: entry.valueType,
		label: entry.label,
		description: entry.description,
		defaultValue: entry.defaultValue,
		scope: entry.scope,
	}));
}
