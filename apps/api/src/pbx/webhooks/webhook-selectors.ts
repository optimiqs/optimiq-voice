import { EVENT_FAMILIES, SUBJECT_ROOTS } from "@optimiq-voice/events/subjects";
import type { EventFamily } from "@optimiq-voice/events/subjects";

/**
 * What a webhook subscription may ask for, and how a delivered message is matched against it.
 *
 * ## A selector is NOT a NATS subject, and that is the tenant boundary
 *
 * The obvious design is to let a subscription carry a subject filter and match it with
 * `matchesSubject`. It is also how a subscription ends up able to name `calls.evt.v1.<someone
 * else's org>.>`, and how the check that stops it becomes a string comparison somebody has to
 * remember to write. So the grammar here deliberately CANNOT express an organization token:
 *
 * ```text
 * calls.evt.v1.>                    every event in the call family
 * calls.evt.v1.channel.answered     one event type in the call family
 * cdr.leg.v1.>                      every CDR leg
 * ```
 *
 * The second form is not a valid subject — a real one carries `<orgId>.<callId>` between the root
 * and the event — and that is the point. Matching is done against the FAMILY and the envelope's
 * `type`, with the organization taken from the delivered subject and compared against the
 * subscription's own tenant by the dispatcher. A selector is a filter on WHAT, never on WHOSE.
 *
 * ## Why these four families and not the other five
 *
 * `call`, `queue`, `voicemail` and `cdr` are the ones an integrator has a use for: a screen-pop, a
 * wallboard, a missed-message alert, a billing export. The five that are absent are absent for
 * reasons rather than for effort:
 *
 * - `media` is the RTP plane's own lifecycle (`apps/mediad` session ended, playback finished). It
 *   is engine plumbing, it is meaningless without the engine's internal session ids, and a consumer
 *   acting on it would be acting on our implementation.
 * - `registration` is the SIP edge's, keyed by an AOR hash, and it is the input to the presence
 *   spine rather than a fact about a call. A tenant that wants "is this phone online" has the
 *   live channel and the device list, both of which answer it without a webhook per REGISTER —
 *   and a phone re-registering every sixty seconds is a delivery rate nobody asked for.
 * - `audit` is the change ledger. It has a read API guarded by `audit.read`, and streaming it to an
 *   endpoint whose configuration is itself an audited change is a loop worth thinking about before
 *   opening.
 * - `provision` is device provisioning attempts, which carry credential-adjacent detail.
 * - `trunk` is the one whose absence is closest to being wrong, so the reasoning is recorded in
 *   full: a carrier going down is exactly the fact an integrator wants a callback for. But what
 *   they want is an ALERT, and `trunk.status.changed` is a raw transition — a flapping trunk is a
 *   POST per flap with no damping, no "still down" reminder and no resolution pairing, and
 *   serving the raw event now would freeze that shape into the integrator contract before the
 *   alerting semantics exist. The status still reaches tenants today through the trunk list's
 *   persisted columns and the `trunks` live topic; when outage callbacks are built, they should
 *   be built as alerts (damped, paired, resendable), not as this event with a URL on it.
 *
 * Adding one later is one entry in {@link WEBHOOK_FAMILIES} plus its stream in the dispatcher.
 */

/** The families a subscription may select. See the note above for the four that are missing. */
export const WEBHOOK_FAMILIES = ["call", "queue", "voicemail", "cdr"] as const;
export type WebhookFamily = (typeof WEBHOOK_FAMILIES)[number];

/** The subject root each selectable family is written as. `cdr` is `cdr.leg.v1`, not `cdr.evt.v1`. */
export const WEBHOOK_FAMILY_ROOTS: Readonly<Record<WebhookFamily, string>> = {
	call: SUBJECT_ROOTS.call,
	queue: SUBJECT_ROOTS.queue,
	voicemail: SUBJECT_ROOTS.voicemail,
	cdr: SUBJECT_ROOTS.cdrLeg,
};

const ROOT_TO_FAMILY: ReadonlyMap<string, WebhookFamily> = new Map(
	(Object.entries(WEBHOOK_FAMILY_ROOTS) as [WebhookFamily, string][]).map(([family, root]) => [
		root,
		family,
	]),
);

/** A parsed selector: a family, and either every event in it or exactly one. */
export interface ParsedSelector {
	readonly family: WebhookFamily;
	/** `undefined` means the `>` form: every event in the family. */
	readonly type?: string;
}

/** Event names are hierarchical (`channel.record.started`), so a type is one or more tokens. */
const EVENT_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

/**
 * Parses one selector, or returns `undefined` when it is not one.
 *
 * Deliberately strict. A selector that cannot match anything is a subscription that silently
 * receives nothing, and the tenant's only evidence would be an endpoint that never fires — which is
 * indistinguishable from every other way this can go wrong. Refusing it at write time turns a
 * support ticket into a 400 with the offending string in it.
 */
export function parseWebhookSelector(selector: string): ParsedSelector | undefined {
	const value = selector.trim();
	if (value.length === 0 || value.length > 128) {
		return undefined;
	}
	for (const [root, family] of ROOT_TO_FAMILY) {
		if (value === `${root}.>`) {
			return { family };
		}
		if (value.startsWith(`${root}.`)) {
			const type = value.slice(root.length + 1);
			// `*` is refused rather than accepted as a synonym for `>`: a single-token wildcard would
			// match `channel` and not `channel.answered`, which is a distinction nobody wants to
			// discover from an endpoint that receives half the family.
			if (!EVENT_PATTERN.test(type)) {
				return undefined;
			}
			return { family, type };
		}
	}
	return undefined;
}

/** Whether every selector in a list is one this platform can serve. */
export function invalidWebhookSelectors(selectors: readonly string[]): readonly string[] {
	return selectors.filter((selector) => parseWebhookSelector(selector) === undefined);
}

/**
 * Whether a subscription wants this event.
 *
 * Takes the family and the type SEPARATELY, and never a subject, for the reason in the header: the
 * subject carries a tenant token and nothing on this path may make a delivery decision from it. The
 * dispatcher resolves the family from the delivered subject, reads the type out of the envelope, and
 * checks the organization itself.
 */
export function selectorsMatch(
	selectors: readonly string[],
	family: string,
	type: string,
): boolean {
	for (const selector of selectors) {
		const parsed = parseWebhookSelector(selector);
		if (parsed === undefined || parsed.family !== family) {
			continue;
		}
		if (parsed.type === undefined || parsed.type === type) {
			return true;
		}
	}
	return false;
}

/** Whether an event family is one webhooks can carry at all. */
export function isWebhookFamily(family: string): family is WebhookFamily {
	return (WEBHOOK_FAMILIES as readonly string[]).includes(family);
}

/**
 * The families this platform knows about that webhooks deliberately do NOT serve.
 *
 * Exported so a spec can assert the list is a decision rather than an oversight: when a ninth family
 * is added to the taxonomy it lands here until somebody argues it onto the other list.
 */
export function unservedEventFamilies(): readonly EventFamily[] {
	return EVENT_FAMILIES.filter((family) => !isWebhookFamily(family));
}
