import { defineRelations } from "drizzle-orm";
import { pbxTables } from "./tables";

/**
 * Relational-query configuration, grouped by domain.
 *
 * Only *real* foreign keys become relations. Polymorphic destination trios deliberately do not:
 * `destination_ref` has no single target table, so it is resolved by the CRUD layer using
 * `DESTINATION_TARGET_TABLES` (see `src/destinations.ts`) rather than by the query builder.
 */
export const pbxRelations = defineRelations(pbxTables, (r) => ({
	// --- Media library -----------------------------------------------------------------------
	mohClass: {
		prompts: r.many.prompt({ from: r.mohClass.id, to: r.prompt.mohClassId }),
		extensions: r.many.extension({ from: r.mohClass.id, to: r.extension.mohClassId }),
		ringGroups: r.many.ringGroup({ from: r.mohClass.id, to: r.ringGroup.mohClassId }),
		queues: r.many.queue({ from: r.mohClass.id, to: r.queue.mohClassId }),
		conferences: r.many.conference({ from: r.mohClass.id, to: r.conference.mohClassId }),
		parkLots: r.many.parkLot({ from: r.mohClass.id, to: r.parkLot.mohClassId }),
	},
	prompt: {
		mohClass: r.one.mohClass({ from: r.prompt.mohClassId, to: r.mohClass.id }),
	},

	// --- Extensions --------------------------------------------------------------------------
	extension: {
		users: r.many.extensionUser({ from: r.extension.id, to: r.extensionUser.extensionId }),
		mohClass: r.one.mohClass({ from: r.extension.mohClassId, to: r.mohClass.id }),
		deviceLines: r.many.deviceLine({ from: r.extension.id, to: r.deviceLine.extensionId }),
		voicemailBoxes: r.many.voicemailBox({ from: r.extension.id, to: r.voicemailBox.extensionId }),
		queueAgents: r.many.queueAgent({ from: r.extension.id, to: r.queueAgent.extensionId }),
		pagingGroupMemberships: r.many.pagingGroupMember({
			from: r.extension.id,
			to: r.pagingGroupMember.extensionId,
		}),
	},
	extensionUser: {
		extension: r.one.extension({
			from: r.extensionUser.extensionId,
			to: r.extension.id,
			optional: false,
		}),
	},

	// --- Devices & provisioning --------------------------------------------------------------
	deviceProfile: {
		keys: r.many.deviceProfileKey({
			from: r.deviceProfile.id,
			to: r.deviceProfileKey.deviceProfileId,
		}),
		devices: r.many.device({ from: r.deviceProfile.id, to: r.device.deviceProfileId }),
	},
	deviceProfileKey: {
		deviceProfile: r.one.deviceProfile({
			from: r.deviceProfileKey.deviceProfileId,
			to: r.deviceProfile.id,
			optional: false,
		}),
	},
	device: {
		deviceProfile: r.one.deviceProfile({
			from: r.device.deviceProfileId,
			to: r.deviceProfile.id,
		}),
		lines: r.many.deviceLine({ from: r.device.id, to: r.deviceLine.deviceId }),
		keys: r.many.deviceKey({ from: r.device.id, to: r.deviceKey.deviceId }),
	},
	deviceLine: {
		device: r.one.device({ from: r.deviceLine.deviceId, to: r.device.id, optional: false }),
		extension: r.one.extension({ from: r.deviceLine.extensionId, to: r.extension.id }),
	},
	deviceKey: {
		device: r.one.device({ from: r.deviceKey.deviceId, to: r.device.id, optional: false }),
	},

	// --- Numbers & emergency -----------------------------------------------------------------
	emergencyAddress: {
		phoneNumbers: r.many.phoneNumber({
			from: r.emergencyAddress.id,
			to: r.phoneNumber.emergencyAddressId,
		}),
	},
	phoneNumber: {
		emergencyAddress: r.one.emergencyAddress({
			from: r.phoneNumber.emergencyAddressId,
			to: r.emergencyAddress.id,
		}),
		inboundRoutes: r.many.inboundRoute({
			from: r.phoneNumber.id,
			to: r.inboundRoute.phoneNumberId,
		}),
	},

	// --- Routing -----------------------------------------------------------------------------
	inboundRoute: {
		phoneNumber: r.one.phoneNumber({ from: r.inboundRoute.phoneNumberId, to: r.phoneNumber.id }),
		timeCondition: r.one.timeCondition({
			from: r.inboundRoute.timeConditionId,
			to: r.timeCondition.id,
		}),
	},
	outboundRoute: {
		timeCondition: r.one.timeCondition({
			from: r.outboundRoute.timeConditionId,
			to: r.timeCondition.id,
		}),
		pinSet: r.one.pinSet({ from: r.outboundRoute.pinSetId, to: r.pinSet.id }),
		translationRuleset: r.one.translationRuleset({
			from: r.outboundRoute.translationRulesetId,
			to: r.translationRuleset.id,
		}),
	},
	timeCondition: {
		rules: r.many.timeConditionRule({
			from: r.timeCondition.id,
			to: r.timeConditionRule.timeConditionId,
		}),
		inboundRoutes: r.many.inboundRoute({
			from: r.timeCondition.id,
			to: r.inboundRoute.timeConditionId,
		}),
		outboundRoutes: r.many.outboundRoute({
			from: r.timeCondition.id,
			to: r.outboundRoute.timeConditionId,
		}),
	},
	timeConditionRule: {
		timeCondition: r.one.timeCondition({
			from: r.timeConditionRule.timeConditionId,
			to: r.timeCondition.id,
			optional: false,
		}),
	},

	// --- IVR ---------------------------------------------------------------------------------
	ivrMenu: {
		parent: r.one.ivrMenu({ from: r.ivrMenu.parentId, to: r.ivrMenu.id, alias: "ivrMenuParent" }),
		children: r.many.ivrMenu({
			from: r.ivrMenu.id,
			to: r.ivrMenu.parentId,
			alias: "ivrMenuParent",
		}),
		options: r.many.ivrMenuOption({ from: r.ivrMenu.id, to: r.ivrMenuOption.ivrMenuId }),
		greetingPrompt: r.one.prompt({
			from: r.ivrMenu.greetingPromptId,
			to: r.prompt.id,
			alias: "ivrMenuGreetingPrompt",
		}),
	},
	ivrMenuOption: {
		ivrMenu: r.one.ivrMenu({
			from: r.ivrMenuOption.ivrMenuId,
			to: r.ivrMenu.id,
			optional: false,
			alias: "ivrMenuOptionMenu",
		}),
	},

	// --- Ring groups -------------------------------------------------------------------------
	ringGroup: {
		destinations: r.many.ringGroupDestination({
			from: r.ringGroup.id,
			to: r.ringGroupDestination.ringGroupId,
		}),
		mohClass: r.one.mohClass({ from: r.ringGroup.mohClassId, to: r.mohClass.id }),
	},
	ringGroupDestination: {
		ringGroup: r.one.ringGroup({
			from: r.ringGroupDestination.ringGroupId,
			to: r.ringGroup.id,
			optional: false,
		}),
	},

	// --- Paging ------------------------------------------------------------------------------
	pagingGroup: {
		members: r.many.pagingGroupMember({
			from: r.pagingGroup.id,
			to: r.pagingGroupMember.pagingGroupId,
		}),
	},
	pagingGroupMember: {
		pagingGroup: r.one.pagingGroup({
			from: r.pagingGroupMember.pagingGroupId,
			to: r.pagingGroup.id,
			optional: false,
		}),
		// Not optional: a member row whose extension is gone cannot exist — the foreign key cascades
		// the delete rather than leaving a member pointing at nothing, which is the whole reason
		// membership is a table and not a text list.
		extension: r.one.extension({
			from: r.pagingGroupMember.extensionId,
			to: r.extension.id,
			optional: false,
		}),
	},

	// --- Queues / ACD ------------------------------------------------------------------------
	queue: {
		tiers: r.many.queueTier({ from: r.queue.id, to: r.queueTier.queueId }),
		mohClass: r.one.mohClass({ from: r.queue.mohClassId, to: r.mohClass.id }),
		agents: r.many.queueAgent({
			from: r.queue.id.through(r.queueTier.queueId),
			to: r.queueAgent.id.through(r.queueTier.queueAgentId),
		}),
	},
	queueAgent: {
		tiers: r.many.queueTier({ from: r.queueAgent.id, to: r.queueTier.queueAgentId }),
		extension: r.one.extension({ from: r.queueAgent.extensionId, to: r.extension.id }),
		queues: r.many.queue({
			from: r.queueAgent.id.through(r.queueTier.queueAgentId),
			to: r.queue.id.through(r.queueTier.queueId),
		}),
	},
	queueTier: {
		queue: r.one.queue({ from: r.queueTier.queueId, to: r.queue.id, optional: false }),
		agent: r.one.queueAgent({
			from: r.queueTier.queueAgentId,
			to: r.queueAgent.id,
			optional: false,
		}),
	},

	// --- Voicemail ---------------------------------------------------------------------------
	voicemailBox: {
		extension: r.one.extension({ from: r.voicemailBox.extensionId, to: r.extension.id }),
		greetings: r.many.voicemailGreeting({
			from: r.voicemailBox.id,
			to: r.voicemailGreeting.voicemailBoxId,
		}),
		messages: r.many.voicemailMessage({
			from: r.voicemailBox.id,
			to: r.voicemailMessage.voicemailBoxId,
		}),
		options: r.many.voicemailOption({
			from: r.voicemailBox.id,
			to: r.voicemailOption.voicemailBoxId,
		}),
	},
	voicemailGreeting: {
		voicemailBox: r.one.voicemailBox({
			from: r.voicemailGreeting.voicemailBoxId,
			to: r.voicemailBox.id,
			optional: false,
		}),
	},
	voicemailMessage: {
		voicemailBox: r.one.voicemailBox({
			from: r.voicemailMessage.voicemailBoxId,
			to: r.voicemailBox.id,
			optional: false,
		}),
	},
	voicemailOption: {
		voicemailBox: r.one.voicemailBox({
			from: r.voicemailOption.voicemailBoxId,
			to: r.voicemailBox.id,
			optional: false,
		}),
	},

	// --- Conferences & park ------------------------------------------------------------------
	conference: {
		mohClass: r.one.mohClass({ from: r.conference.mohClassId, to: r.mohClass.id }),
	},
	parkLot: {
		mohClass: r.one.mohClass({ from: r.parkLot.mohClassId, to: r.mohClass.id }),
	},

	// --- T2 admin block ------------------------------------------------------------------------
	//
	// Six of these nine tables have no relation at all, and that is the honest configuration rather
	// than an omission: `call_flow`, `destination_alias`, `audio_stream`, `dial_by_name_directory`,
	// `speed_dial` and `org_limit` carry destination trios and nothing else, and a trio is
	// deliberately NOT a relation — `destination_ref` has no single target table, which is the whole
	// point of this file's header. `schema.spec.ts` asserts one key per table, so they are declared
	// empty rather than absent.
	callFlow: {},
	destinationAlias: {},
	audioStream: {},
	dialByNameDirectory: {},
	speedDial: {},
	orgLimit: {},
	pinSet: {
		entries: r.many.pinSetEntry({ from: r.pinSet.id, to: r.pinSetEntry.pinSetId }),
		outboundRoutes: r.many.outboundRoute({ from: r.pinSet.id, to: r.outboundRoute.pinSetId }),
	},
	pinSetEntry: {
		pinSet: r.one.pinSet({
			from: r.pinSetEntry.pinSetId,
			to: r.pinSet.id,
			optional: false,
		}),
	},
	translationRuleset: {
		rules: r.many.translationRule({
			from: r.translationRuleset.id,
			to: r.translationRule.translationRulesetId,
		}),
		outboundRoutes: r.many.outboundRoute({
			from: r.translationRuleset.id,
			to: r.outboundRoute.translationRulesetId,
		}),
		trunks: r.many.trunk({
			from: r.translationRuleset.id,
			to: r.trunk.inboundTranslationRulesetId,
		}),
	},
	translationRule: {
		translationRuleset: r.one.translationRuleset({
			from: r.translationRule.translationRulesetId,
			to: r.translationRuleset.id,
			optional: false,
		}),
	},
	// Both sides point at `prompt`, which is what makes a phrase a prompt row rather than a table of
	// its own — see `PROMPT_KINDS`. Named `phrase` and `audio` so a reader is never left wondering
	// which of two `prompt` relations is the container and which is the content.
	phraseStep: {
		phrase: r.one.prompt({
			from: r.phraseStep.phraseId,
			to: r.prompt.id,
			optional: false,
		}),
		audio: r.one.prompt({
			from: r.phraseStep.promptId,
			to: r.prompt.id,
			optional: false,
		}),
	},
	trunk: {
		inboundTranslationRuleset: r.one.translationRuleset({
			from: r.trunk.inboundTranslationRulesetId,
			to: r.translationRuleset.id,
		}),
	},
}));

export type PbxRelations = typeof pbxRelations;
