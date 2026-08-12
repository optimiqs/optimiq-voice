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

	return {
		ok: true,
		endpoint: input.extensionDialTemplate.replaceAll("{number}", from),
		...(extension.outboundCallerIdNumber === undefined
			? {}
			: { callerIdNumber: extension.outboundCallerIdNumber }),
		...(extension.outboundCallerIdName === undefined
			? {}
			: { callerIdName: extension.outboundCallerIdName }),
	};
}
