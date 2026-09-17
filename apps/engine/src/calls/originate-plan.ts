import { resolveInternal, resolveOutbound } from "@optimiq-voice/routing";
import type { OriginateRefusalReason } from "@optimiq-voice/events/schemas";
import type { RoutingArtifact } from "@optimiq-voice/routing";

/**
 * The decidable half of a click-to-call, as a pure function over the tenant's compiled artifact.
 *
 * ## Why this is separate from the responder and from the orchestrator
 *
 * Everything an originate can be refused for BEFORE a channel exists is a question about the
 * tenant's own dial plan: does `1001` name an extension, and may that extension reach `to`? Both
 * are answered from the artifact the engine already caches, with no media server, no database and
 * no I/O — so they are answered here, in a function a spec can drive with a fixture and a table of
 * cases. What is left for the orchestrator is the part that genuinely needs a media server.
 *
 * ## The refusals it can produce, and the order they are decided in
 *
 * `unknown_extension` first, then `invalid_target`, and the ordering is the same authorisation
 * argument `sip-transfer.service.ts` makes: resolving `to` reads the tenant's routing tables, and
 * doing that for a `fromExtension` that turned out not to exist would let a caller probe a dial
 * plan by timing a request for an extension they do not have.
 *
 * ## The B-side is resolved AS THE EXTENSION, which is the toll-fraud boundary
 *
 * `to` is resolved with `from = fromExtension` through the same internal-then-outbound ladder
 * `ChannelOrchestrator.resolveRoute` walks for a call the extension dialled by hand — so the outbound
 * tables' toll-class gate applies to the extension that is about to be rung, and a click-to-call can
 * never reach a destination its own user could not have dialled. Resolving it as the API's caller,
 * or skipping the resolve and letting the walk discover it later, would both hand any holder of an
 * API key an unmetered outbound dialer.
 *
 * Note what this deliberately does NOT do: it discards the plan it resolved. The B-side is walked
 * for real when the extension answers and the leg arrives in Stasis, against the artifact that is
 * current THEN. Carrying this plan forward would pin the dial to a routing snapshot taken while the
 * phone was still ringing.
 */

/** The endpoint to ring and the number to hand the walk, or the reason neither could be produced. */
export type OriginatePlan =
	| {
			readonly ok: true;
			/** Media-server endpoint for the A-leg, from `ENGINE_EXTENSION_DIAL_TEMPLATE`. */
			readonly endpoint: string;
			/** The extension's own outbound caller id, when the artifact carries one. */
			readonly callerIdNumber?: string;
			readonly callerIdName?: string;
			/**
			 * The extension's CLIR setting, when the artifact carries one. Absent means `allowed`.
			 *
			 * Read through a cast because `ExtensionIndexEntry` has no such field YET — the column, the
			 * compiler mapping and the API surface are `packages/routing`'s and `apps/api`'s to add. The
			 * engine is written to honour it the moment it appears rather than to need a second change.
			 */
			readonly callerIdPresentation?: "allowed" | "restricted";
	  }
	| { readonly ok: false; readonly reason: OriginateRefusalReason; readonly error: string };

export interface OriginatePlanInput {
	readonly fromExtension: string;
	readonly to: string;
	/** `ENGINE_EXTENSION_DIAL_TEMPLATE`, with `{number}` still in it. */
	readonly extensionDialTemplate: string;
	/** Evaluation instant — time conditions are routing predicates, so a plan needs a clock. */
	readonly now: Date;
}

export function planOriginate(artifact: RoutingArtifact, input: OriginatePlanInput): OriginatePlan {
	const from = input.fromExtension.trim();
	const to = input.to.trim();

	const extension = artifact.extensionsByNumber[from];
	if (extension === undefined) {
		return {
			ok: false,
			reason: "unknown_extension",
			error: `no extension ${from} in this organization`,
		};
	}
	if (!extension.enabled) {
		// A disabled extension is refused as UNKNOWN rather than getting a name of its own. An
		// administrator switched it off, and a caller who may originate is not owed the distinction
		// between "never existed" and "was turned off" — while an integrator who is owed it can read
		// the extension through the CRUD surface they already have.
		return {
			ok: false,
			reason: "unknown_extension",
			error: `extension ${from} is disabled`,
		};
	}

	// Internal first, then outbound, and NOT the other way round: an extension dialling another
	// extension must reach it rather than matching an outbound pattern that happens to be wide.
	const internal = resolveInternal(artifact, { from, dialed: to, now: input.now });
	if (!internal.matched) {
		const outbound = resolveOutbound(artifact, { from, dialed: to, now: input.now });
		if (!outbound.matched) {
			return {
				ok: false,
				reason: "invalid_target",
				error: outbound.reason ?? `nothing in this organization's plan matches ${to}`,
			};
		}
	}

	const presentation = (
		extension as { readonly outboundCallerIdPresentation?: "allowed" | "restricted" }
	).outboundCallerIdPresentation;

	return {
		ok: true,
		endpoint: input.extensionDialTemplate.replaceAll("{number}", from),
		...(presentation === "allowed" || presentation === "restricted"
			? { callerIdPresentation: presentation }
			: {}),
		...(extension.outboundCallerIdNumber === undefined
			? {}
			: { callerIdNumber: extension.outboundCallerIdNumber }),
		...(extension.outboundCallerIdName === undefined
			? {}
			: { callerIdName: extension.outboundCallerIdName }),
	};
}

/**
 * The decidable half of a QUEUE CALLBACK — the third question this file answers.
 *
 * ## What is different from a click-to-call, and why it is a second function
 *
 * The two share a shape and almost nothing else. A click-to-call rings an extension and is
 * authorised as that extension; a callback rings whoever was WAITING and is authorised as the
 * queue. There is no `fromExtension` to look up, so `unknown_extension` cannot happen.
 *
 * The destination is resolved internal-then-outbound, because the party who waited is as likely to
 * be an extension as a customer on a trunk — see the note at the resolve itself for why that is not
 * the coincidence this used to refuse.
 *
 * ## The caller-ID policy, which is the whole reason this is not a parameter on `planOriginate`
 *
 * A callback presents the QUEUE's identity. The person answering is the customer, and showing them
 * either their own number (the caller id of the call being settled) or an agent's direct line (which
 * they would then ring back and bypass the queue) are both wrong. So the cascade is: the queue's
 * pinned caller id, then whatever the matched outbound route resolved — which is already the org's
 * `outboundCallerIdNumber` cascade with the route's own override in front of it.
 *
 * ## `tollClass` fails CLOSED, deliberately
 *
 * A queue reached on an extension number carries that extension's class; one that is not reachable
 * on a number has no entitlement of its own, and this refuses rather than inventing one. Inventing
 * `international` would turn a queue with a misconfigured callback into an unmetered dialler, and
 * the refusal names what to fix — give the queue a number, or pin a class on it.
 */
export type QueueCallbackPlan =
	| {
			readonly ok: true;
			/** The number to dial, after the matched route's digit manipulation. */
			readonly destination: string;
			/**
			 * Which rung matched — `internal` for a party this organization owns, `outbound` for one
			 * reached over a trunk. The orchestrator needs it because the two are dialled completely
			 * differently: an AOR at the tenant's realm, or a trunk the matched route names.
			 */
			readonly context: "internal" | "outbound";
			/** What the callback presents. See the caller-ID note above. */
			readonly callerIdNumber?: string;
			readonly callerIdName?: string;
			/** The outbound plan node the resolve matched, for the orchestrator's trunk selection. */
			readonly planNodeId?: string;
	  }
	| { readonly ok: false; readonly reason: OriginateRefusalReason; readonly error: string };

export interface QueueCallbackPlanInput {
	/** The number to ring — the one the caller presented while they were waiting. */
	readonly to: string;
	/** The queue's own number, when it has one. Supplies the toll class; see the note above. */
	readonly queueNumber?: string;
	/** Caller id pinned on the queue. Takes precedence over the route's own. */
	readonly callerIdNumber?: string;
	readonly callerIdName?: string;
	/** Evaluation instant — outbound routes carry time gates, so a plan needs a clock. */
	readonly now: Date;
}

export function planQueueCallback(
	artifact: RoutingArtifact,
	input: QueueCallbackPlanInput,
): QueueCallbackPlan {
	const to = input.to.trim();
	if (to === "") {
		return { ok: false, reason: "bad_request", error: "a callback needs a number to dial" };
	}
	const from = input.queueNumber?.trim() ?? "";

	// INTERNAL first, then outbound — the same ladder a handset gets, and it is here because the
	// outbound-only resolve refused every callback this platform has ever promised. A caller who
	// waited in a queue and asked to be rung back is very often an EXTENSION: an internal transfer
	// into support, a branch office, a warm hand-off. `resolveOutbound` matches nothing for `1201`,
	// so the runner answered `invalid_target` every thirty seconds after the caller had been told
	// their place was held.
	//
	// The collision this order used to be afraid of is not one. `resolveInternal` matches only what
	// is actually IN the tenant's internal table, so a match means the number names a destination
	// this organization owns — not a coincidence with a customer's DID, which is an E.164 no
	// extension table contains. An external number therefore falls straight through to the outbound
	// rung it always used, unchanged.
	const internal = resolveInternal(artifact, { from, dialed: to, now: input.now });
	const onNet = internal.matched && internal.blocked === undefined;
	const resolved = onNet
		? internal
		: resolveOutbound(artifact, { from, dialed: to, now: input.now });

	if (!resolved.matched) {
		return {
			ok: false,
			reason: "invalid_target",
			error: resolved.reason ?? `nothing in this organization's plan matches ${to}`,
		};
	}
	if (resolved.blocked !== undefined) {
		return {
			ok: false,
			reason: "invalid_target",
			error: `${to} is blocked by this organization's call-block rules`,
		};
	}

	const callerIdNumber = input.callerIdNumber ?? resolved.callerIdNumber;
	const callerIdName = input.callerIdName ?? resolved.callerIdName;
	return {
		ok: true,
		destination: resolved.dialedNumber ?? to,
		context: onNet ? "internal" : "outbound",
		...(callerIdNumber === undefined ? {} : { callerIdNumber }),
		...(callerIdName === undefined ? {} : { callerIdName }),
		...(resolved.plan?.entryNodeId === undefined ? {} : { planNodeId: resolved.plan.entryNodeId }),
	};
}
