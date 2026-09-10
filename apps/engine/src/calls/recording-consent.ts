import { requiresAllParty } from "./recording-jurisdiction";
import type { CompiledRoutingSettings, RecordingConsentPolicy } from "@optimiq-voice/routing";

/**
 * Turning a tenant's configuration into the one decision a recording gate can act on.
 *
 * ## Why the resolution is pure and lives outside `CallControl`
 *
 * The gate in {@link import("./call-control").CallControl.startRecording} has one job — play
 * something, maybe wait for a digit, and refuse or proceed — and it runs on the call path with a
 * media plane attached. Everything ahead of that decision is arithmetic over configuration: which
 * of two policies wins, which jurisdictions the two numbers touch, and therefore who has to be
 * told. Arithmetic over configuration is exactly the part a compliance argument is made of, and
 * exactly the part that is impossible to prove from a spec that also has to stand up a media
 * server. So it is a function of its inputs, with no clock, no I/O and no knowledge of a leg.
 *
 * ## What `parties` names, and why it is not "the A-leg and the B-leg"
 *
 * `caller` is the party on the leg BEING RECORDED and `callee` is the party on the other side of
 * its bridge. Deliberately relative rather than absolute: the recorder is attached to whichever leg
 * the walk (or the verb, or the agent's record key) named, and on an OUTBOUND recorded call that
 * leg is the agent while the person who has to hear the announcement is the far end. Reading the
 * pair as "inbound caller" and "the extension they dialled" would announce to the wrong side of
 * every outbound call, which is the single case the announcement exists for.
 *
 * Two entries therefore mean "both sides", one means "the recorded leg only", and none means no
 * announcement is owed at all.
 */

/** The compiled policy as the artifact carries it. Absent from an artifact compiled before it existed. */
type CompiledRecordingPolicy = NonNullable<CompiledRoutingSettings["recording"]>;

/** Which side of the recorded conversation an announcement is owed to. */
export type ConsentParty = "caller" | "callee";

/** Everything the gate needs, decided before the gate runs. */
export interface ResolvedRecordingConsent {
	readonly policy: RecordingConsentPolicy;
	/** The `prompt` row the tenant named, for the record. Absent means the engine's seeded stem. */
	readonly promptId?: string;
	/**
	 * That prompt already rendered into the media server's vocabulary.
	 *
	 * Separate from {@link promptId} because the two are read by different consumers: a compliance
	 * report wants the row id that was configured, and the media plane wants `sound:` plus a path.
	 * Resolving the row id needs the artifact's phrase table, which belongs to whoever fetched the
	 * artifact — so it is filled in there and merely PLAYED here. Absent means the gate falls back to
	 * `CallControlSettings.consentPrompt`.
	 */
	readonly promptMedia?: string;
	readonly acceptDigit: string;
	readonly declineDigit: string;
	readonly parties: readonly ConsentParty[];
	/** The configured jurisdictions this call touched. Empty when none did. */
	readonly regions: readonly string[];
}

/** The call facts the resolution reads. All optional — an anonymous inbound call has most of none. */
export interface RecordingConsentCall {
	/** The policy the DID or inbound route overrode the org's with. Absent means "inherit". */
	readonly didConsentPolicy?: RecordingConsentPolicy;
	readonly didConsentPromptId?: string;
	readonly callerIdNumber?: string;
	readonly destinationNumber?: string;
	/**
	 * Which way the RECORDED leg was set up. Absent means "the engine could not say", which is read
	 * as inbound — the shape every artifact and every caller before this field behaved as.
	 *
	 * The one input that is about the call rather than about configuration, and it is here because
	 * `parties` is meaningless without it on an outbound call. See {@link resolveRecordingConsent}.
	 */
	readonly direction?: "inbound" | "outbound";
}

/**
 * The consent this call owes, from the tenant's policy and the numbers on it.
 *
 * ## The override beats the org, and it beats it whole
 *
 * A per-DID policy is not a hint the org default is blended with: a tenant that sets
 * `announce-and-require-keypress` on one published number and nothing anywhere else has said
 * something specific about that number, and an org default that could still upgrade or downgrade it
 * would make the per-DID control unreadable. So the DID's policy REPLACES the org's when it is
 * present, and inherits it entirely when it is not. The prompt is taken independently, because a
 * DID that overrides the policy and not the wording is a real configuration — the org's prompt is
 * the tenant's own recorded voice and there is no reason to lose it.
 *
 * ## Why a jurisdiction match can only ever make the outcome LOUDER
 *
 * When {@link requiresAllParty} matches, two things change and both are upgrades: the announcement
 * goes to BOTH sides, and a policy of `none` becomes `announce`. Nothing downgrades. An all-party
 * jurisdiction is precisely the situation in which silence is the problem, so a region list that
 * matched must never be able to turn an announcement off — a tenant who wants less says so by
 * shortening the region list, which is a deliberate act on a settings page, not a side effect of a
 * caller ID.
 *
 * ## An outbound recorded call announces to the far end, jurisdiction or no jurisdiction
 *
 * `caller` is the recorded leg and `callee` is the party on the other side of it, so on an OUTBOUND
 * recorded call `caller` is the tenant's own agent and `callee` is the member of the public being
 * called. Announcing to the recorded leg alone there tells the recording party about their own
 * recording and tells the recorded party nothing — which is not a weaker announcement, it is no
 * announcement at all: the obligation runs to the far end and the tenant placing the call is the one
 * who holds it. So `announce` on an outbound call reaches BOTH sides even when no region matched,
 * and §6 of the contract already says so in words ("outbound recorded calls therefore announce to
 * the far end because the far end IS the peer leg") — this is the code catching up with it.
 *
 * Inbound is deliberately NOT widened the same way. There the recorded leg is the member of the
 * public who dialled in, telling them is telling the party the rule protects, and telling the
 * tenant's own agent as well is what the jurisdiction upgrade is for.
 *
 * `announce-and-require-keypress` is left alone by the upgrade rather than being widened to both
 * sides' keypresses. One party can be asked for a digit and answer it; asking two parties for a
 * digit on one call is a gate with no defined failure — whose decline decides, and what happens to
 * the caller who pressed accept while the other side timed out — and inventing an answer to that
 * here would be inventing tenant policy.
 *
 * ## An absent policy is `none`, and that is a compatibility guarantee
 *
 * `CompiledRoutingSettings.recording` is absent from every artifact compiled before this feature
 * existed. Those artifacts describe tenants who were recording calls with no consent gate at all,
 * and the gate must therefore be inert for them: policy `none`, no regions, no parties. An engine
 * rolled out ahead of a recompile behaves exactly like the release before it, which is what makes
 * the rollout order not matter.
 */
export function resolveRecordingConsent(
	recording: CompiledRecordingPolicy | undefined,
	call: RecordingConsentCall,
): ResolvedRecordingConsent {
	if (recording === undefined) {
		return {
			policy: "none",
			// The digits still have values because the shape is not optional, and these are the two the
			// compiler defaults to. Nothing reads them while the policy is `none`.
			acceptDigit: "1",
			declineDigit: "2",
			parties: NO_PARTIES,
			regions: NO_REGIONS,
		};
	}

	const configured = call.didConsentPolicy ?? recording.consentPolicy;
	const regions = requiresAllParty(
		[call.callerIdNumber, call.destinationNumber],
		recording.allPartyRegions,
	);
	const allParty = regions.length > 0;
	const policy: RecordingConsentPolicy =
		allParty && configured === "none" ? "announce" : configured;
	const promptId = call.didConsentPromptId ?? recording.consentPromptId;
	const bothSides = allParty || call.direction === "outbound";

	return {
		policy,
		acceptDigit: recording.acceptDigit,
		declineDigit: recording.declineDigit,
		parties: policy === "none" ? NO_PARTIES : bothSides ? BOTH_PARTIES : RECORDED_PARTY,
		regions,
		...(promptId === undefined || promptId === "" ? {} : { promptId }),
	};
}

const NO_PARTIES: readonly ConsentParty[] = Object.freeze([]);
const RECORDED_PARTY: readonly ConsentParty[] = Object.freeze(["caller" as const]);
const BOTH_PARTIES: readonly ConsentParty[] = Object.freeze(["caller" as const, "callee" as const]);
const NO_REGIONS: readonly string[] = Object.freeze([]);
