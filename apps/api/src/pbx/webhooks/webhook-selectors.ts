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
 * ## Why these six families and not the other six
 *
 * `call`, `queue`, `voicemail`, `cdr`, `security` and `messaging` are the ones an integrator has a
 * use for: a screen-pop, a wallboard, a missed-message alert, a billing export, a fraud alert, an
 * inbound text. The six that are absent are absent for reasons rather than for effort:
 *
 * - `media` is the RTP plane's own lifecycle (`apps/mediad` session ended, playback finished). It
 *   is engine plumbing, it is meaningless without the engine's internal session ids, and a consumer
 *   acting on it would be acting on our implementation.
 * - `registration` is the SIP edge's, keyed by an AOR hash, and it is the input to the presence
 *   spine rather than a fact about a call. A tenant that wants "is this phone online" has the
 *   live channel and the device list, both of which answer it without a webhook per REGISTER —
 *   and a phone re-registering every sixty seconds is a delivery rate nobody asked for.
 * - `sipDialog` is `sip.evt.v1` — the SIP edge's own dialog lifecycle (`dialog.progressed`,
 *   `dialog.answered`, `dialog.held`, `dialog.resumed`, `dialog.terminated`, `dialog.dtmf`). It is
 *   the closest thing on this list to a family an integrator would ACCEPT if offered, and that is
 *   precisely why it must not be: every one of those transitions already has a business-level
 *   equivalent in `call` — `channel.ringing`, `channel.answered`, `channel.hangup` — and serving
 *   both would deliver one phone call twice, in two vocabularies, to a consumer with no way to tell
 *   that the two are the same call. Whichever one they built against would then be the contract, and
 *   half of them would have built against SIP. The `media` argument applies on top: a dialog event is
 *   keyed by a leg id and a `sipd` instance, so acting on it means acting on where our pods happen to
 *   be. The signalling plane is an implementation of the call, not a second account of it.
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
 *
 * ## `security` and `messaging` are the two the reasoning above ARGUES FOR
 *
 * `security.evt.v1` carries `fraud-signal` — the toll-fraud gate refusing a dial, and the anomaly
 * detector's hourly findings. It is served, and every objection raised against the six above fails
 * against it:
 *
 * - it is not engine plumbing (`media`, `sipDialog`) — a fraud alert names an extension, a
 *   destination and a threshold, all of them things the tenant configured;
 * - it is not a second vocabulary for something already served — nothing in `call` or `cdr` says
 *   "we refused this because it looked like fraud";
 * - it is not the raw-transition problem `trunk` has. The event is already an ALERT rather than a
 *   state change: it is damped by construction (the detector runs hourly, the gate fires once per
 *   refused call), it carries a severity a consumer can route on, and there is nothing to pair a
 *   resolution with because a refusal does not resolve;
 * - and unlike `audit`, streaming it to an endpoint is not a loop — the endpoint's own configuration
 *   is not a fraud signal.
 *
 * It is also the family with the strongest case for existing at all: an alert nobody sees until they
 * open a screen is an alert that arrives after the invoice.
 *
 * `messaging.evt.v1` carries `message.received` and `message.delivered`, and it is served for the
 * same reasons. An inbound SMS is a customer-originated fact addressed to the tenant, named in the
 * tenant's own vocabulary (a number they own, a conversation, a body) with nothing of the media or
 * signalling plane in it — a text has no dialog and never reaches `mediad` at all. It is served by
 * nothing else in this list: `call` says nothing about a text. And the payload is already the shape
 * a notification wants — thin by construction, the body capped and the media bytes absent, so the
 * content is fetched back through the API under `messaging.read` rather than fanned out to an
 * arbitrary endpoint. See `apps/api/src/messaging/messaging-event.publisher.ts`.
 */

/** The families a subscription may select. See the note above for the six that are missing. */
export const WEBHOOK_FAMILIES = [
	"call",
	"queue",
	"voicemail",
	"cdr",
	"security",
	"messaging",
] as const;
export type WebhookFamily = (typeof WEBHOOK_FAMILIES)[number];

/** The subject root each selectable family is written as. `cdr` is `cdr.leg.v1`, not `cdr.evt.v1`. */
export const WEBHOOK_FAMILY_ROOTS: Readonly<Record<WebhookFamily, string>> = {
	call: SUBJECT_ROOTS.call,
	queue: SUBJECT_ROOTS.queue,
	voicemail: SUBJECT_ROOTS.voicemail,
	cdr: SUBJECT_ROOTS.cdrLeg,
	security: SUBJECT_ROOTS.security,
	messaging: SUBJECT_ROOTS.messaging,
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
	return parsedSelectorsMatch(parseWebhookSelectors(selectors), family, type);
}

/**
 * The parse half of {@link selectorsMatch}, hoisted so a caller can do it once.
 *
 * A parse is a pure function of a string that only changes when the subscription row does, and the
 * dispatcher's hot path would otherwise re-run it — a map walk plus a regex — for every selector of
 * every cached subscription on every platform event. Unparseable selectors are dropped here rather
 * than carried: they can never match, and `invalidWebhookSelectors` already refuses them at write
 * time.
 */
export function parseWebhookSelectors(selectors: readonly string[]): readonly ParsedSelector[] {
	const parsed: ParsedSelector[] = [];
	for (const selector of selectors) {
		const one = parseWebhookSelector(selector);
		if (one !== undefined) {
			parsed.push(one);
		}
	}
	return parsed;
}

/** The match half, over selectors already run through {@link parseWebhookSelectors}. */
export function parsedSelectorsMatch(
	selectors: readonly ParsedSelector[],
	family: string,
	type: string,
): boolean {
	for (const parsed of selectors) {
		if (parsed.family !== family) {
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
 * Exported so a spec can assert the list is a decision rather than an oversight: when a thirteenth family
 * is added to the taxonomy it lands here until somebody argues it onto the other list.
 */
export function unservedEventFamilies(): readonly EventFamily[] {
	return EVENT_FAMILIES.filter((family) => !isWebhookFamily(family));
}
