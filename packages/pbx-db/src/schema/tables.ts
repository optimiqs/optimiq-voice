import { destinationAlias } from "./aliases-schema";
import { callFlow } from "./call-flows-schema";
import { conference, parkLot } from "./conferences-schema";
import { device, deviceKey, deviceLine, deviceProfile, deviceProfileKey } from "./devices-schema";
import { dialByNameDirectory } from "./directory-schema";
import { emergencyAddress } from "./emergency-schema";
import { extension, extensionUser } from "./extensions-schema";
import { faxMessage, faxServer } from "./fax-schema";
import { callBlockRule, featureCode } from "./features-schema";
import { ivrMenu, ivrMenuOption } from "./ivr-schema";
import { orgLimit } from "./limits-schema";
import { mohClass, prompt } from "./media-schema";
import { phoneNumber } from "./numbers-schema";
import { projectionOutbox } from "./outbox-schema";
import { pagingGroup, pagingGroupMember } from "./paging-schema";
import { phraseStep } from "./phrases-schema";
import { pinSet, pinSetEntry } from "./pins-schema";
import { queue, queueAgent, queueTier } from "./queues-schema";
import { ringGroup, ringGroupDestination } from "./ring-groups-schema";
import { inboundRoute, outboundRoute } from "./routing-schema";
import { auditLog, sipAclEntry, sipAuthEvent } from "./security-schema";
import { orgSetting, userSetting } from "./settings-schema";
import { speedDial } from "./speed-dials-schema";
import { audioStream } from "./streams-schema";
import { timeCondition, timeConditionRule } from "./time-conditions-schema";
import { translationRule, translationRuleset } from "./translations-schema";
import { trunk } from "./trunks-schema";
import {
	voicemailBox,
	voicemailGreeting,
	voicemailMessage,
	voicemailOption,
} from "./voicemail-schema";
import { webhookSubscription } from "./webhooks-schema";

/**
 * Every table in the telephony bounded context, keyed by its TypeScript name.
 *
 * This is the object `defineRelations` and the relational query builder consume; it is also the
 * single list the RLS preflight plan is derived from, so a table added here without a policy
 * fails preflight instead of silently shipping unprotected.
 */
export const pbxTables = {
	auditLog,
	audioStream,
	callBlockRule,
	callFlow,
	conference,
	device,
	deviceKey,
	deviceLine,
	deviceProfile,
	deviceProfileKey,
	destinationAlias,
	dialByNameDirectory,
	emergencyAddress,
	extension,
	extensionUser,
	faxMessage,
	faxServer,
	featureCode,
	inboundRoute,
	ivrMenu,
	ivrMenuOption,
	mohClass,
	orgLimit,
	orgSetting,
	outboundRoute,
	pagingGroup,
	pagingGroupMember,
	parkLot,
	phraseStep,
	phoneNumber,
	pinSet,
	pinSetEntry,
	projectionOutbox,
	prompt,
	queue,
	queueAgent,
	queueTier,
	ringGroup,
	ringGroupDestination,
	sipAclEntry,
	sipAuthEvent,
	speedDial,
	timeCondition,
	timeConditionRule,
	translationRule,
	translationRuleset,
	trunk,
	userSetting,
	voicemailBox,
	voicemailGreeting,
	voicemailMessage,
	voicemailOption,
	webhookSubscription,
} as const;

export type PbxTables = typeof pbxTables;
