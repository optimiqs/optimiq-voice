import {
	callBlockRule,
	conference,
	eq,
	extension,
	featureCode,
	inboundRoute,
	ivrMenu,
	ivrMenuOption,
	orgSetting,
	outboundRoute,
	parkLot,
	type PbxDatabaseTransaction,
	phoneNumber,
	queue,
	ringGroup,
	ringGroupDestination,
	timeCondition,
	timeConditionRule,
	trunk,
	voicemailBox,
} from "@optimiq-voice/pbx-db";
import type { OrgRoutingSnapshot, RoutingSettingsInput } from "@optimiq-voice/routing";

/**
 * The snapshot loader — one RLS-scoped read per collection, projected onto the compiler's `*Input`
 * types.
 *
 * ## The two rules the compiler's author wrote down, and why they are not negotiable
 *
 * 1. **Do not filter out disabled rows.** `enabled = false` is a routing fact, not an absence: the
 *    compiler emits a `disabled-entity` diagnostic and a deliberately absent match for it. A
 *    loader that added `where enabled` would silently turn "this route is switched off" into "this
 *    route was never configured", and the admin UI would lose the diagnostic that explains why a
 *    DID goes nowhere.
 * 2. **Do not pre-join.** Child collections are flat arrays keyed by their parent id, because that
 *    is exactly what `select … where organization_id = $1` returns. The compiler owns every join
 *    and sorts everything it walks, which is what makes its output deterministic.
 *
 * Nineteen statements, no joins, run inside the caller's tenant transaction — so RLS scopes them
 * and `organization_id` never appears in a predicate here. That is deliberate: the policy is the
 * filter, and duplicating it in the query would make a missing policy invisible.
 *
 * The reads are issued as one `Promise.all` batch: they are independent, they are all on the same
 * connection inside one transaction (so postgres.js pipelines them), and the compile-on-write path
 * runs this on every mutation.
 */
export async function loadOrgRoutingSnapshot(
	transaction: PbxDatabaseTransaction,
	organizationId: string,
): Promise<OrgRoutingSnapshot> {
	const [
		extensions,
		phoneNumbers,
		trunks,
		inboundRoutes,
		outboundRoutes,
		timeConditions,
		timeConditionRules,
		ivrMenus,
		ivrMenuOptions,
		ringGroups,
		ringGroupDestinations,
		queues,
		voicemailBoxes,
		conferences,
		parkLots,
		featureCodes,
		callBlockRules,
		settingRows,
	] = await Promise.all([
		transaction.select().from(extension),
		transaction.select().from(phoneNumber),
		transaction.select().from(trunk),
		transaction.select().from(inboundRoute),
		transaction.select().from(outboundRoute),
		transaction.select().from(timeCondition),
		transaction.select().from(timeConditionRule),
		transaction.select().from(ivrMenu),
		transaction.select().from(ivrMenuOption),
		transaction.select().from(ringGroup),
		transaction.select().from(ringGroupDestination),
		transaction.select().from(queue),
		transaction.select().from(voicemailBox),
		transaction.select().from(conference),
		transaction.select().from(parkLot),
		transaction.select().from(featureCode),
		transaction.select().from(callBlockRule),
		transaction.select().from(orgSetting).where(eq(orgSetting.category, ROUTING_SETTINGS_CATEGORY)),
	]);

	return {
		organizationId,
		settings: readRoutingSettings(settingRows),
		extensions: extensions.map((row) => ({
			id: row.id,
			enabled: row.enabled,
			number: row.number,
			label: row.label,
			callerIdName: row.callerIdName,
			callerIdNumber: row.callerIdNumber,
			outboundCallerIdName: row.outboundCallerIdName,
			outboundCallerIdNumber: row.outboundCallerIdNumber,
			emergencyCallerIdNumber: row.emergencyCallerIdNumber,
			voicemailEnabled: row.voicemailEnabled,
			doNotDisturb: row.doNotDisturb,
			forwardAllEnabled: row.forwardAllEnabled,
			forwardAllDestination: row.forwardAllDestination,
			forwardBusyEnabled: row.forwardBusyEnabled,
			forwardBusyDestination: row.forwardBusyDestination,
			forwardNoAnswerEnabled: row.forwardNoAnswerEnabled,
			forwardNoAnswerDestination: row.forwardNoAnswerDestination,
			forwardUnregisteredEnabled: row.forwardUnregisteredEnabled,
			forwardUnregisteredDestination: row.forwardUnregisteredDestination,
			recordPolicy: row.recordPolicy,
			mohClassId: row.mohClassId,
			tollClass: row.tollClass,
			callTimeoutSeconds: row.callTimeoutSeconds,
		})),
		phoneNumbers: phoneNumbers.map((row) => ({
			id: row.id,
			enabled: row.enabled,
			e164: row.e164,
			label: row.label,
			callerIdNamePrefix: row.callerIdNamePrefix,
			recordEnabled: row.recordEnabled,
			voiceEnabled: row.voiceEnabled,
			destinationType: row.destinationType,
			destinationRef: row.destinationRef,
			destinationData: row.destinationData,
		})),
		trunks: trunks.map((row) => ({
			id: row.id,
			enabled: row.enabled,
			name: row.name,
			kind: row.kind,
			sipDomain: row.sipDomain,
			sipProxy: row.sipProxy,
			outboundProxy: row.outboundProxy,
			transport: row.transport,
			codecPrefs: row.codecPrefs,
			maxChannels: row.maxChannels,
			callerIdNumberOverride: row.callerIdNumberOverride,
		})),
		inboundRoutes: inboundRoutes.map((row) => ({
			id: row.id,
			enabled: row.enabled,
			name: row.name,
			priority: row.priority,
			matchKind: row.matchKind,
			matchPattern: row.matchPattern,
			phoneNumberId: row.phoneNumberId,
			callerIdPattern: row.callerIdPattern,
			destinationType: row.destinationType,
			destinationRef: row.destinationRef,
			destinationData: row.destinationData,
			failoverDestinationType: row.failoverDestinationType,
			failoverDestinationRef: row.failoverDestinationRef,
			failoverDestinationData: row.failoverDestinationData,
			timeConditionId: row.timeConditionId,
			recordEnabled: row.recordEnabled,
		})),
		outboundRoutes: outboundRoutes.map((row) => ({
			id: row.id,
			enabled: row.enabled,
			name: row.name,
			priority: row.priority,
			matchKind: row.matchKind,
			dialPatterns: row.dialPatterns,
			stripDigits: row.stripDigits,
			prependDigits: row.prependDigits,
			tollClass: row.tollClass,
			trunkPriority: row.trunkPriority,
			timeConditionId: row.timeConditionId,
			failoverDestinationType: row.failoverDestinationType,
			failoverDestinationRef: row.failoverDestinationRef,
			failoverDestinationData: row.failoverDestinationData,
			callerIdNumberOverride: row.callerIdNumberOverride,
			recordEnabled: row.recordEnabled,
		})),
		timeConditions: timeConditions.map((row) => ({
			id: row.id,
			enabled: row.enabled,
			name: row.name,
			timezone: row.timezone,
			destinationType: row.destinationType,
			destinationRef: row.destinationRef,
			destinationData: row.destinationData,
			nomatchDestinationType: row.nomatchDestinationType,
			nomatchDestinationRef: row.nomatchDestinationRef,
			nomatchDestinationData: row.nomatchDestinationData,
		})),
		timeConditionRules: timeConditionRules.map((row) => ({
			id: row.id,
			enabled: row.enabled,
			timeConditionId: row.timeConditionId,
			ordinal: row.ordinal,
			label: row.label,
			predicates: row.predicates,
		})),
		ivrMenus: ivrMenus.map((row) => ({
			id: row.id,
			enabled: row.enabled,
			name: row.name,
			extensionNumber: row.extensionNumber,
			parentId: row.parentId,
			greetingPromptId: row.greetingPromptId,
			shortGreetingPromptId: row.shortGreetingPromptId,
			invalidPromptId: row.invalidPromptId,
			timeoutPromptId: row.timeoutPromptId,
			digitTimeoutMs: row.digitTimeoutMs,
			interDigitTimeoutMs: row.interDigitTimeoutMs,
			maxDigits: row.maxDigits,
			maxFailures: row.maxFailures,
			maxTimeouts: row.maxTimeouts,
			directDialEnabled: row.directDialEnabled,
			timeoutDestinationType: row.timeoutDestinationType,
			timeoutDestinationRef: row.timeoutDestinationRef,
			timeoutDestinationData: row.timeoutDestinationData,
			invalidDestinationType: row.invalidDestinationType,
			invalidDestinationRef: row.invalidDestinationRef,
			invalidDestinationData: row.invalidDestinationData,
		})),
		ivrMenuOptions: ivrMenuOptions.map((row) => ({
			id: row.id,
			enabled: row.enabled,
			ivrMenuId: row.ivrMenuId,
			ordinal: row.ordinal,
			matchKind: row.matchKind,
			matchValue: row.matchValue,
			label: row.label,
			destinationType: row.destinationType,
			destinationRef: row.destinationRef,
			destinationData: row.destinationData,
		})),
		ringGroups: ringGroups.map((row) => ({
			id: row.id,
			enabled: row.enabled,
			name: row.name,
			extensionNumber: row.extensionNumber,
			strategy: row.strategy,
			ringTimeoutSeconds: row.ringTimeoutSeconds,
			callerIdNamePrefix: row.callerIdNamePrefix,
			ignoreBusy: row.ignoreBusy,
			confirmEnabled: row.confirmEnabled,
			confirmPromptId: row.confirmPromptId,
			mohClassId: row.mohClassId,
			ringbackPromptId: row.ringbackPromptId,
			timeoutDestinationType: row.timeoutDestinationType,
			timeoutDestinationRef: row.timeoutDestinationRef,
			timeoutDestinationData: row.timeoutDestinationData,
		})),
		ringGroupDestinations: ringGroupDestinations.map((row) => ({
			id: row.id,
			enabled: row.enabled,
			ringGroupId: row.ringGroupId,
			ordinal: row.ordinal,
			delaySeconds: row.delaySeconds,
			timeoutSeconds: row.timeoutSeconds,
			confirmRequired: row.confirmRequired,
			destinationType: row.destinationType,
			destinationRef: row.destinationRef,
			destinationData: row.destinationData,
		})),
		queues: queues.map((row) => ({
			id: row.id,
			enabled: row.enabled,
			name: row.name,
			extensionNumber: row.extensionNumber,
			strategy: row.strategy,
			mohClassId: row.mohClassId,
			greetingPromptId: row.greetingPromptId,
			announcePromptId: row.announcePromptId,
			maxWaitSeconds: row.maxWaitSeconds,
			maxWaitNoAgentSeconds: row.maxWaitNoAgentSeconds,
			announcePositionEnabled: row.announcePositionEnabled,
			announceFrequencySeconds: row.announceFrequencySeconds,
			recordEnabled: row.recordEnabled,
			timeoutDestinationType: row.timeoutDestinationType,
			timeoutDestinationRef: row.timeoutDestinationRef,
			timeoutDestinationData: row.timeoutDestinationData,
		})),
		voicemailBoxes: voicemailBoxes.map((row) => ({
			id: row.id,
			enabled: row.enabled,
			mailboxNumber: row.mailboxNumber,
			label: row.label,
			extensionId: row.extensionId,
			mwiEnabled: row.mwiEnabled,
			maxMessageSeconds: row.maxMessageSeconds,
		})),
		conferences: conferences.map((row) => ({
			id: row.id,
			enabled: row.enabled,
			name: row.name,
			roomNumber: row.roomNumber,
			requiresPin: row.pinHash !== null,
			maxMembers: row.maxMembers,
			mohClassId: row.mohClassId,
			waitForModerator: row.waitForModerator,
			recordEnabled: row.recordEnabled,
		})),
		parkLots: parkLots.map((row) => ({
			id: row.id,
			enabled: row.enabled,
			name: row.name,
			slotStart: row.slotStart,
			slotEnd: row.slotEnd,
			timeoutSeconds: row.timeoutSeconds,
			mohClassId: row.mohClassId,
			timeoutDestinationType: row.timeoutDestinationType,
			timeoutDestinationRef: row.timeoutDestinationRef,
			timeoutDestinationData: row.timeoutDestinationData,
		})),
		featureCodes: featureCodes.map((row) => ({
			id: row.id,
			enabled: row.enabled,
			code: row.code,
			action: row.action,
			params: row.params,
			label: row.label,
		})),
		callBlockRules: callBlockRules.map((row) => ({
			id: row.id,
			enabled: row.enabled,
			pattern: row.pattern,
			matchKind: row.matchKind,
			direction: row.direction,
			action: row.action,
			label: row.label,
		})),
	};
}

/** The `org_setting.category` the routing settings live under. */
export const ROUTING_SETTINGS_CATEGORY = "routing";

interface SettingRow {
	readonly name: string;
	readonly value: unknown;
	readonly enabled: boolean;
}

/**
 * Projects `org_setting` rows onto {@link RoutingSettingsInput}.
 *
 * Only the seven names the compiler declares are read; anything else in the `routing` category is
 * ignored rather than passed through, so a stray row cannot change how calls are routed. A
 * disabled row is treated as absent, which is what the settings cascade means by `enabled`.
 */
export function readRoutingSettings(rows: readonly SettingRow[]): RoutingSettingsInput {
	const byName = new Map(rows.filter((row) => row.enabled).map((row) => [row.name, row.value]));

	const asString = (name: string): string | undefined => {
		const value = byName.get(name);
		return typeof value === "string" && value.length > 0 ? value : undefined;
	};
	const asNullableString = (name: string): string | null | undefined => {
		if (!byName.has(name)) {
			return undefined;
		}
		const value = byName.get(name);
		return typeof value === "string" && value.length > 0 ? value : null;
	};

	const trunkContinueOnCauses = byName.get("trunkContinueOnCauses");
	const outboundEnabled = byName.get("outboundEnabled");

	return {
		...(asString("defaultTimezone") === undefined
			? {}
			: { defaultTimezone: asString("defaultTimezone") }),
		...(asNullableString("voicemailPrefix") === undefined
			? {}
			: { voicemailPrefix: asNullableString("voicemailPrefix") }),
		...(asNullableString("voicemailCheckPrefix") === undefined
			? {}
			: { voicemailCheckPrefix: asNullableString("voicemailCheckPrefix") }),
		...(asNullableString("outboundCallerIdNumber") === undefined
			? {}
			: { outboundCallerIdNumber: asNullableString("outboundCallerIdNumber") }),
		...(asNullableString("outboundCallerIdName") === undefined
			? {}
			: { outboundCallerIdName: asNullableString("outboundCallerIdName") }),
		...(Array.isArray(trunkContinueOnCauses)
			? {
					trunkContinueOnCauses: trunkContinueOnCauses.filter(
						(entry): entry is string => typeof entry === "string",
					),
				}
			: {}),
		...(typeof outboundEnabled === "boolean" ? { outboundEnabled } : {}),
	};
}
