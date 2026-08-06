/**
 * The resolvers: artifact + one call's facts → the plan the engine executes.
 *
 * # Three entry points, three security contexts
 *
 * `resolveInbound` serves traffic that arrived from a carrier and has authenticated nothing.
 * `resolveInternal` serves a registered extension dialing another. `resolveOutbound` serves a
 * registered extension dialing the world. They are separate functions over separate tables because
 * the difference between them is the toll-fraud boundary
 * (`plans/reference/freeswitch-capabilities.md` §7): unauthenticated traffic cannot reach a trunk
 * because the function that reaches trunks is not the one it is allowed to call.
 *
 * Internal dialing does **not** fall through to outbound. An engine that wants both asks for both,
 * in that order, and the second call is where the toll-class gate applies. Making the fallthrough
 * explicit is the whole point: an implicit one is exactly how a misconfigured IVR direct-dial ends
 * up dialing Cuba.
 *
 * # The clock is an argument, again
 *
 * Every resolver takes `now`. A routing decision that depends on an ambient clock cannot be
 * reproduced, and "why did this call go to the night service at 4pm?" is a question that gets asked.
 */

import { PlanNodeNotFoundError } from "./errors";
import { matchFeatureCode } from "./feature-codes";
import { applyDigitManipulation, matchPattern } from "./patterns";
import { tollClassCovers } from "./snapshot";
import { evaluateTimeCondition } from "./time-conditions";
import type {
	CompiledCallBlockRule,
	EmergencyRule,
	InboundRule,
	OutboundRule,
	RouteTimeGate,
	RoutingArtifact,
	RoutingContext,
} from "./artifact";
import type { Diagnostic } from "./diagnostics";
import type { ExecutionPlan, PlanNode, PlanNodeId } from "./plan";
import type { CallBlockAction, CallBlockDirection, TollClass } from "./snapshot";

/** How far a chain of time-condition gates may be followed before it is called a loop. */
export const MAX_GATE_DEPTH = 16;

export interface ResolveInboundInput {
	/** The dialed DID, E.164 with the leading `+`, exactly as it is stored on the number. */
	readonly did: string;
	readonly callerNumber?: string;
	readonly callerName?: string;
	readonly now: Date;
}

export interface ResolveInternalInput {
	/** The calling extension's number. */
	readonly from: string;
	readonly dialed: string;
	readonly now: Date;
}

export interface ResolveOutboundInput {
	readonly from: string;
	readonly dialed: string;
	readonly now: Date;
	/**
	 * Overrides the toll class looked up from `from`.
	 *
	 * Only for callers that are not extensions and are nevertheless entitled to dial out — a queue
	 * callback, an API-originated call. Supplying it for a caller that *is* an extension would let
	 * an extension escape its own class, so the resolver ignores it in that case.
	 */
	readonly tollClass?: TollClass;
}

/** Why a call was screened, and what the screening rule asked for. */
export interface BlockOutcome {
	readonly ruleId: string;
	readonly action: CallBlockAction;
	readonly label?: string;
}

export interface ResolvedRoute {
	readonly matched: boolean;
	readonly context: RoutingContext;
	/** Absent only when nothing matched *and* the artifact has no terminal for the context. */
	readonly plan?: ExecutionPlan;
	readonly matchedRuleId?: string;
	readonly matchedRuleName?: string;
	/** The number to dial, after any digit manipulation. Outbound only. */
	readonly dialedNumber?: string;
	/** Digits dialed after a feature code. Internal only. */
	readonly featureArgument?: string;
	readonly callerIdName?: string;
	readonly callerIdNumber?: string;
	/** Regex capture groups from the matching pattern, `$1` first. */
	readonly captures?: readonly string[];
	readonly recordEnabled?: boolean;
	/** Set when a call-block rule matched, whatever its action. */
	readonly blocked?: BlockOutcome;
	/** One line for the "why did this call go there?" ticket; mirrors the rpc contract's `reason`. */
	readonly reason?: string;
	readonly diagnostics: readonly Diagnostic[];
}

/** Reads a node, failing loudly on an artifact whose table is not closed. */
export function planNode(artifact: RoutingArtifact, nodeId: PlanNodeId): PlanNode {
	const node = artifact.nodes[nodeId];
	if (node === undefined) {
		throw new PlanNodeNotFoundError(nodeId);
	}
	return node;
}

/**
 * Builds a plan from an entry node.
 *
 * `nodes` is the artifact's own table by reference: resolution is on the call path and must not
 * copy a subgraph per call.
 */
export function planFrom(artifact: RoutingArtifact, entryNodeId: PlanNodeId): ExecutionPlan {
	return { entryNodeId, nodes: artifact.nodes };
}

/**
 * Screens a number against the compiled call-block table.
 *
 * The table is pre-sorted most-specific-first with `allow` ahead of `block` at equal specificity,
 * so the first match is the answer — an allowlist entry beats the broad prefix block it sits under
 * without any scoring at match time.
 */
export function checkCallBlock(
	rules: readonly CompiledCallBlockRule[],
	value: string | undefined,
	direction: CallBlockDirection,
): CompiledCallBlockRule | null {
	if (value === undefined || value.length === 0) {
		return null;
	}
	for (const rule of rules) {
		if (rule.direction !== direction && rule.direction !== "both") {
			continue;
		}
		if (matchPattern(rule.pattern, value) !== null) {
			return rule;
		}
	}
	return null;
}

/**
 * The hangup node a blocking action terminates at, or `null` when the call proceeds.
 *
 * Both ids are always present: the compiler materialises the well-known terminals whether or not a
 * tenant's configuration mentions them, so a screening decision never has to check.
 */
function blockTerminalNodeId(action: CallBlockAction): PlanNodeId | null {
	switch (action) {
		case "block": {
			return "hangup:CALL_REJECTED";
		}
		case "reject": {
			return "hangup:USER_BUSY";
		}
		default: {
			// `allow` proceeds; `voicemail` proceeds too, with the outcome flagged so the engine can
			// divert to the callee's mailbox — which is a fact only the engine has.
			return null;
		}
	}
}

// -----------------------------------------------------------------------------------------------
// Emergency
// -----------------------------------------------------------------------------------------------

/**
 * The emergency short-circuit, run FIRST by `resolveInternal` and `resolveOutbound`.
 *
 * Everything it skips, it skips on purpose. Kari's Law requires that `911` be dialable from any
 * station with no prefix and no permission, and every gate this function sits in front of is a
 * permission somebody can revoke:
 *
 * - **`outbound.enabled`** — the organization-wide outbound kill switch. A tenant who disables
 *   outbound calling for the weekend has not disabled emergency calling.
 * - **"the caller must be a known extension"** — a leg with no toll class cannot dial out. It can
 *   dial a dispatcher.
 * - **the toll-class gate** — an `internal`-class handset in a warehouse is exactly the station
 *   most likely to need this.
 * - **`callBlock`** — a rule blocking a caller or a prefix cannot block `911`.
 * - **time conditions** — the emergency node carries no gate and no failover, so there is nothing
 *   for `followGates` to close.
 *
 * The caller id it returns is the ELIN precedence, and it is the one thing here that is NOT a
 * bypass: the calling extension's own `emergencyCallerIdNumber` (the desk's registered
 * dispatchable location) beats the organization's default ELIN, which beats the ordinary outbound
 * caller id. A PSAP dials back what it is given.
 */
function resolveEmergency(
	artifact: RoutingArtifact,
	rule: EmergencyRule,
	context: RoutingContext,
	from: string,
	diagnostics: Diagnostic[],
): ResolvedRoute {
	const caller = artifact.extensionsByNumber[from];
	const node = artifact.nodes[rule.destinationNodeId];
	const elin = node !== undefined && node.kind === "trunk-dial" ? node.elin : undefined;
	const callerIdNumber =
		caller?.emergencyCallerIdNumber ?? elin ?? artifact.settings.outboundCallerIdNumber;

	diagnostics.push({
		severity: "info",
		code: "emergency-call",
		message: `${rule.dialed} matched the emergency table; it dials ${rule.number} presenting ${callerIdNumber ?? "no caller id"}, bypassing the outbound kill switch, the toll-class gate, the call-block table and every time condition.`,
	});

	return compactRoute({
		matched: true,
		context,
		plan: planFrom(artifact, rule.destinationNodeId),
		matchedRuleId: "emergency",
		matchedRuleName: rule.dialed,
		dialedNumber: rule.number,
		callerIdNumber,
		callerIdName: caller?.outboundCallerIdName ?? artifact.settings.outboundCallerIdName,
		reason: `emergency call to ${rule.dialed}`,
		diagnostics,
	});
}

interface GateWalk {
	readonly nodeId: PlanNodeId;
	readonly diagnostics: readonly Diagnostic[];
}

/**
 * Follows time-condition nodes until a node that actually does something.
 *
 * The gate is evaluated here rather than by the engine so that the plan handed over is already the
 * answer for *this* instant. The nodes stay in the table so a call-flow inspector can still show
 * which gate was crossed.
 */
function followGates(artifact: RoutingArtifact, entryNodeId: PlanNodeId, now: Date): GateWalk {
	const diagnostics: Diagnostic[] = [];
	let nodeId = entryNodeId;

	for (let depth = 0; depth < MAX_GATE_DEPTH; depth += 1) {
		const node = artifact.nodes[nodeId];
		if (node === undefined || node.kind !== "time-condition") {
			return { nodeId, diagnostics };
		}
		const condition = artifact.timeConditions[node.timeConditionId];
		if (condition === undefined) {
			diagnostics.push({
				severity: "warning",
				code: "missing-time-condition",
				message: `Time condition "${node.timeConditionId}" is missing from the artifact; the gate was treated as open.`,
			});
			nodeId = node.matchNodeId;
			continue;
		}
		const evaluation = evaluateTimeCondition(condition, now);
		diagnostics.push({
			severity: "info",
			code: evaluation.matched ? "time-condition-open" : "time-condition-closed",
			message: `Time condition "${condition.name}" evaluated ${evaluation.matched ? "open" : "closed"} at ${evaluation.at.date} ${pad2(evaluation.at.hour)}:${pad2(evaluation.at.minute)} ${condition.timezone}.`,
			subject: { kind: "time-condition", id: condition.id, name: condition.name },
		});
		const next = evaluation.matched ? node.matchNodeId : node.noMatchNodeId;
		if (next === undefined) {
			return { nodeId: "hangup:NORMAL_CLEARING", diagnostics };
		}
		nodeId = next;
	}

	diagnostics.push({
		severity: "warning",
		code: "plan-depth-exceeded",
		message: `Followed ${MAX_GATE_DEPTH} time-condition gates without reaching a destination; the chain is a loop.`,
	});
	return { nodeId, diagnostics };
}

function pad2(value: number): string {
	return value < 10 ? `0${value}` : String(value);
}

/** Evaluates a route's gate. `null` means "no gate"; `false` with no closed branch means "skip me". */
function gateOutcome(
	artifact: RoutingArtifact,
	gate: RouteTimeGate | undefined,
	now: Date,
	diagnostics: Diagnostic[],
): { readonly open: boolean; readonly closedNodeId?: PlanNodeId } {
	if (gate === undefined) {
		return { open: true };
	}
	const condition = artifact.timeConditions[gate.timeConditionId];
	if (condition === undefined) {
		diagnostics.push({
			severity: "warning",
			code: "missing-time-condition",
			message: `Time condition "${gate.timeConditionId}" is missing from the artifact; the gate was treated as open.`,
		});
		return { open: true };
	}
	const evaluation = evaluateTimeCondition(condition, now);
	diagnostics.push({
		severity: "info",
		code: evaluation.matched ? "time-condition-open" : "time-condition-closed",
		message: `Time condition "${condition.name}" evaluated ${evaluation.matched ? "open" : "closed"} at ${evaluation.at.date} ${pad2(evaluation.at.hour)}:${pad2(evaluation.at.minute)} ${condition.timezone}.`,
		subject: { kind: "time-condition", id: condition.id, name: condition.name },
	});
	return evaluation.matched
		? { open: true }
		: gate.closedNodeId === undefined
			? { open: false }
			: { open: false, closedNodeId: gate.closedNodeId };
}

// -----------------------------------------------------------------------------------------------
// Inbound
// -----------------------------------------------------------------------------------------------

/**
 * Resolves a call that arrived on a DID.
 *
 * Order: screen the caller, walk the rule table, fall back to the DID's own destination, then give
 * up with `UNALLOCATED_NUMBER`. The DID default is what makes "buy a number, point it at the IVR"
 * a one-field operation rather than a route the tenant has to remember to create.
 */
export function resolveInbound(
	artifact: RoutingArtifact,
	input: ResolveInboundInput,
): ResolvedRoute {
	const diagnostics: Diagnostic[] = [];
	const blockRule = checkCallBlock(artifact.callBlock, input.callerNumber, "inbound");
	let blocked: BlockOutcome | undefined;

	if (blockRule !== null && blockRule.action !== "allow") {
		blocked = compactOutcome(blockRule);
		const terminal = blockTerminalNodeId(blockRule.action);
		diagnostics.push({
			severity: "info",
			code: "call-blocked",
			message: `Caller ${input.callerNumber ?? "(unknown)"} matched call-block rule "${blockRule.label ?? blockRule.id}" (${blockRule.action}).`,
			subject: { kind: "call-block-rule", id: blockRule.id },
		});
		if (terminal !== null) {
			return {
				matched: true,
				context: "inbound",
				plan: planFrom(artifact, terminal),
				blocked,
				reason: `blocked by call-block rule ${blockRule.id}`,
				diagnostics,
			};
		}
	}

	for (const rule of artifact.inbound.rules) {
		const match = matchInboundRule(rule, input);
		if (match === null) {
			continue;
		}
		const gate = gateOutcome(artifact, rule.timeGate, input.now, diagnostics);
		if (!gate.open) {
			if (gate.closedNodeId === undefined) {
				continue;
			}
			return finishInbound(
				artifact,
				rule,
				gate.closedNodeId,
				match.captures,
				input,
				diagnostics,
				blocked,
				"time condition closed",
			);
		}
		return finishInbound(
			artifact,
			rule,
			rule.destinationNodeId,
			match.captures,
			input,
			diagnostics,
			blocked,
			undefined,
		);
	}

	const did = artifact.inbound.didDefaults[input.did];
	if (did !== undefined) {
		const walk = followGates(artifact, did.destinationNodeId, input.now);
		diagnostics.push(...walk.diagnostics);
		return compactRoute({
			matched: true,
			context: "inbound",
			plan: planFrom(artifact, walk.nodeId),
			matchedRuleId: did.phoneNumberId,
			matchedRuleName: did.e164,
			recordEnabled: did.recordEnabled,
			callerIdName: prefixedCallerName(did.callerIdNamePrefix, input.callerName),
			callerIdNumber: input.callerNumber,
			blocked,
			reason: "matched the DID's own destination",
			diagnostics,
		});
	}

	diagnostics.push({
		severity: "info",
		code: "no-match",
		message: `No inbound route or DID matched ${input.did}.`,
	});
	return compactRoute({
		matched: false,
		context: "inbound",
		plan: planFrom(artifact, artifact.inbound.noMatchNodeId),
		blocked,
		reason: `no inbound route matched ${input.did}`,
		diagnostics,
	});
}

function matchInboundRule(
	rule: InboundRule,
	input: ResolveInboundInput,
): { readonly captures: readonly string[] } | null {
	if (rule.e164 !== undefined && rule.e164 !== input.did) {
		return null;
	}
	const match = matchPattern(rule.pattern, input.did);
	if (match === null) {
		return null;
	}
	if (rule.callerPattern !== undefined) {
		if (input.callerNumber === undefined) {
			return null;
		}
		if (matchPattern(rule.callerPattern, input.callerNumber) === null) {
			return null;
		}
	}
	return { captures: match.captures };
}

function finishInbound(
	artifact: RoutingArtifact,
	rule: InboundRule,
	entryNodeId: PlanNodeId,
	captures: readonly string[],
	input: ResolveInboundInput,
	diagnostics: Diagnostic[],
	blocked: BlockOutcome | undefined,
	reason: string | undefined,
): ResolvedRoute {
	const walk = followGates(artifact, entryNodeId, input.now);
	diagnostics.push(...walk.diagnostics);
	return compactRoute({
		matched: true,
		context: "inbound",
		plan: planFrom(artifact, walk.nodeId),
		matchedRuleId: rule.id,
		matchedRuleName: rule.name,
		recordEnabled: rule.recordEnabled,
		captures: captures.length > 0 ? captures : undefined,
		callerIdName: prefixedCallerName(rule.callerIdNamePrefix, input.callerName),
		callerIdNumber: input.callerNumber,
		blocked,
		reason: reason ?? `matched inbound route "${rule.name}"`,
		diagnostics,
	});
}

function prefixedCallerName(
	prefix: string | undefined,
	name: string | undefined,
): string | undefined {
	if (prefix === undefined) {
		return name;
	}
	return `${prefix}${name ?? ""}`;
}

// -----------------------------------------------------------------------------------------------
// Internal
// -----------------------------------------------------------------------------------------------

/**
 * Resolves a call between two internal parties.
 *
 * Order is fixed and is part of the contract: feature codes, voicemail prefixes, exact internal
 * numbers, park slots. Feature codes first because they begin with `*` and no internal number may;
 * voicemail prefixes before numbers so `*99200` is a mailbox and not an extension named `*99200`.
 */
export function resolveInternal(
	artifact: RoutingArtifact,
	input: ResolveInternalInput,
): ResolvedRoute {
	const diagnostics: Diagnostic[] = [];

	// Before the call-block table, before the feature codes, before the number map. See
	// `resolveEmergency` for the list of gates this ordering bypasses and why each one is on it.
	const emergency = artifact.internal.emergency?.[input.dialed];
	if (emergency !== undefined) {
		return resolveEmergency(artifact, emergency, "internal", input.from, diagnostics);
	}

	const blockRule = checkCallBlock(artifact.callBlock, input.dialed, "both");
	if (blockRule !== null && blockRule.action !== "allow") {
		const terminal = blockTerminalNodeId(blockRule.action);
		diagnostics.push({
			severity: "info",
			code: "call-blocked",
			message: `Internal call to ${input.dialed} matched call-block rule "${blockRule.label ?? blockRule.id}" (${blockRule.action}).`,
			subject: { kind: "call-block-rule", id: blockRule.id },
		});
		if (terminal !== null) {
			return {
				matched: true,
				context: "internal",
				plan: planFrom(artifact, terminal),
				blocked: compactOutcome(blockRule),
				reason: `blocked by call-block rule ${blockRule.id}`,
				diagnostics,
			};
		}
	}

	const feature = matchFeatureCode(artifact.internal.featureCodes, input.dialed);
	if (feature !== null) {
		return compactRoute({
			matched: true,
			context: "internal",
			plan: planFrom(artifact, feature.featureCode.nodeId),
			matchedRuleId: feature.featureCode.id,
			matchedRuleName: feature.featureCode.code,
			featureArgument: feature.argument.length > 0 ? feature.argument : undefined,
			reason: `matched feature code ${feature.featureCode.code}`,
			diagnostics,
		});
	}

	for (const entry of artifact.internal.voicemailPrefixes) {
		if (!input.dialed.startsWith(entry.prefix)) {
			continue;
		}
		const mailboxNumber = input.dialed.slice(entry.prefix.length);
		if (mailboxNumber.length === 0) {
			continue;
		}
		const mailbox = artifact.internal.mailboxes[mailboxNumber];
		if (mailbox === undefined) {
			continue;
		}
		const nodeId = entry.mode === "check" ? mailbox.checkNodeId : mailbox.leaveNodeId;
		return compactRoute({
			matched: true,
			context: "internal",
			plan: planFrom(artifact, nodeId),
			matchedRuleId: mailbox.voicemailBoxId,
			matchedRuleName: `${entry.prefix}${mailboxNumber}`,
			reason: `matched voicemail prefix ${entry.prefix}`,
			diagnostics,
		});
	}

	const internalNumber = artifact.internal.numbers[input.dialed];
	if (internalNumber !== undefined) {
		const walk = followGates(artifact, internalNumber.nodeId, input.now);
		diagnostics.push(...walk.diagnostics);
		return compactRoute({
			matched: true,
			context: "internal",
			plan: planFrom(artifact, walk.nodeId),
			matchedRuleId: internalNumber.entityId,
			matchedRuleName: internalNumber.number,
			callerIdNumber: input.from,
			reason: `matched ${internalNumber.kind} ${internalNumber.number}`,
			diagnostics,
		});
	}

	const slot = Number.parseInt(input.dialed, 10);
	if (String(slot) === input.dialed) {
		for (const range of artifact.internal.parkSlots) {
			if (slot >= range.slotStart && slot <= range.slotEnd) {
				return compactRoute({
					matched: true,
					context: "internal",
					plan: planFrom(artifact, range.nodeId),
					matchedRuleId: range.parkLotId,
					matchedRuleName: String(slot),
					reason: `matched park slot ${slot}`,
					diagnostics,
				});
			}
		}
	}

	diagnostics.push({
		severity: "info",
		code: "no-match",
		message: `No internal number, feature code or park slot matched ${input.dialed}.`,
	});
	return compactRoute({
		matched: false,
		context: "internal",
		plan: planFrom(artifact, artifact.internal.noMatchNodeId),
		reason: `no internal destination matched ${input.dialed}; try outbound routing`,
		diagnostics,
	});
}

// -----------------------------------------------------------------------------------------------
// Outbound
// -----------------------------------------------------------------------------------------------

/**
 * Resolves a call leaving the organization.
 *
 * The caller must be a known extension (or supply an explicit toll class, for callers that are not
 * extensions at all). Everything else is a refusal: an unauthenticated leg that somehow reaches
 * this function still cannot dial out, because it has no toll class to dial out *with*.
 *
 * A route whose class the caller does not hold does not end resolution — the walk continues, since
 * a lower-class route further down may also match. Only when every matching route has been refused
 * does the call take `deniedNodeId`.
 */
export function resolveOutbound(
	artifact: RoutingArtifact,
	input: ResolveOutboundInput,
): ResolvedRoute {
	const diagnostics: Diagnostic[] = [];

	// FIRST — ahead of the kill switch, the caller lookup, the toll-class gate and the call-block
	// table, all four of which can refuse a call and none of which may refuse this one.
	const emergency = artifact.outbound.emergency?.[input.dialed];
	if (emergency !== undefined) {
		return resolveEmergency(artifact, emergency, "outbound", input.from, diagnostics);
	}

	if (!artifact.outbound.enabled) {
		diagnostics.push({
			severity: "info",
			code: "toll-class-denied",
			message: "Outbound calling is disabled for this organization.",
		});
		return compactRoute({
			matched: false,
			context: "outbound",
			plan: planFrom(artifact, artifact.outbound.deniedNodeId),
			reason: "outbound calling is disabled for this organization",
			diagnostics,
		});
	}

	const caller = artifact.extensionsByNumber[input.from];
	const tollClass = caller?.tollClass ?? input.tollClass;
	if (tollClass === undefined) {
		diagnostics.push({
			severity: "warning",
			code: "caller-not-internal",
			message: `Caller ${input.from} is not an extension of this organization and supplied no toll class; outbound dialing refused.`,
		});
		return compactRoute({
			matched: false,
			context: "outbound",
			plan: planFrom(artifact, artifact.outbound.deniedNodeId),
			reason: `caller ${input.from} is not entitled to dial out`,
			diagnostics,
		});
	}

	const blockRule = checkCallBlock(artifact.callBlock, input.dialed, "outbound");
	if (blockRule !== null && blockRule.action !== "allow") {
		const terminal = blockTerminalNodeId(blockRule.action);
		diagnostics.push({
			severity: "info",
			code: "call-blocked",
			message: `Outbound call to ${input.dialed} matched call-block rule "${blockRule.label ?? blockRule.id}" (${blockRule.action}).`,
			subject: { kind: "call-block-rule", id: blockRule.id },
		});
		if (terminal !== null) {
			return {
				matched: true,
				context: "outbound",
				plan: planFrom(artifact, terminal),
				blocked: compactOutcome(blockRule),
				reason: `blocked by call-block rule ${blockRule.id}`,
				diagnostics,
			};
		}
	}

	let denied = false;
	for (const rule of artifact.outbound.rules) {
		const match = matchOutboundRule(rule, input.dialed);
		if (match === null) {
			continue;
		}
		if (!tollClassCovers(tollClass, rule.tollClass)) {
			denied = true;
			diagnostics.push({
				severity: "info",
				code: "toll-class-denied",
				message: `Route "${rule.name}" requires toll class "${rule.tollClass}"; caller ${input.from} holds "${tollClass}".`,
				subject: { kind: "outbound-route", id: rule.id, name: rule.name },
			});
			continue;
		}
		const gate = gateOutcome(artifact, rule.timeGate, input.now, diagnostics);
		if (!gate.open) {
			if (gate.closedNodeId === undefined) {
				continue;
			}
			const walk = followGates(artifact, gate.closedNodeId, input.now);
			diagnostics.push(...walk.diagnostics);
			return compactRoute({
				matched: true,
				context: "outbound",
				plan: planFrom(artifact, walk.nodeId),
				matchedRuleId: rule.id,
				matchedRuleName: rule.name,
				reason: `route "${rule.name}" is closed by its time condition`,
				diagnostics,
			});
		}

		const dialedNumber = applyDigitManipulation(
			{ stripDigits: rule.stripDigits, prependDigits: rule.prependDigits ?? null },
			input.dialed,
		);
		if (dialedNumber === null) {
			diagnostics.push({
				severity: "warning",
				code: "digit-manipulation-underflow",
				message: `Route "${rule.name}" strips ${rule.stripDigits} digits from ${input.dialed}, leaving nothing to dial.`,
				subject: { kind: "outbound-route", id: rule.id, name: rule.name },
			});
			continue;
		}

		return compactRoute({
			matched: true,
			context: "outbound",
			plan: planFrom(artifact, rule.destinationNodeId),
			matchedRuleId: rule.id,
			matchedRuleName: rule.name,
			dialedNumber,
			captures: match.captures.length > 0 ? match.captures : undefined,
			recordEnabled: rule.recordEnabled,
			callerIdNumber:
				rule.callerIdNumberOverride ??
				caller?.outboundCallerIdNumber ??
				artifact.settings.outboundCallerIdNumber,
			callerIdName: caller?.outboundCallerIdName ?? artifact.settings.outboundCallerIdName,
			reason: `matched outbound route "${rule.name}"`,
			diagnostics,
		});
	}

	if (denied) {
		return compactRoute({
			matched: false,
			context: "outbound",
			plan: planFrom(artifact, artifact.outbound.deniedNodeId),
			reason: `caller ${input.from} (${tollClass}) may not take any route matching ${input.dialed}`,
			diagnostics,
		});
	}

	diagnostics.push({
		severity: "info",
		code: "no-match",
		message: `No outbound route matched ${input.dialed}.`,
	});
	return compactRoute({
		matched: false,
		context: "outbound",
		plan: planFrom(artifact, artifact.outbound.noMatchNodeId),
		reason: `no outbound route matched ${input.dialed}`,
		diagnostics,
	});
}

function matchOutboundRule(
	rule: OutboundRule,
	dialed: string,
): { readonly captures: readonly string[] } | null {
	for (const pattern of rule.patterns) {
		const match = matchPattern(pattern, dialed);
		if (match !== null) {
			return { captures: match.captures };
		}
	}
	return null;
}

function compactOutcome(rule: CompiledCallBlockRule): BlockOutcome {
	return rule.label === undefined
		? { ruleId: rule.id, action: rule.action }
		: { ruleId: rule.id, action: rule.action, label: rule.label };
}

/** Drops `undefined` fields so a resolved route compares cleanly in tests and logs tidily. */
function compactRoute(route: ResolvedRoute): ResolvedRoute {
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(route)) {
		const value = (route as unknown as Record<string, unknown>)[key];
		if (value !== undefined) {
			out[key] = value;
		}
	}
	return out as unknown as ResolvedRoute;
}
