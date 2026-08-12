import {
	audioStream,
	callBlockRule,
	callFlow,
	conference,
	destinationAlias,
	dialByNameDirectory,
	emergencyAddress,
	eq,
	extension,
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
	type PbxDatabaseTransaction,
	phoneNumber,
	phraseStep,
	pinSet,
	pinSetEntry,
	prompt,
	queue,
	ringGroup,
	ringGroupDestination,
	speedDial,
	timeCondition,
	timeConditionRule,
	translationRule,
	translationRuleset,
	trunk,
	voicemailBox,
	voicemailGreeting,
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
 * Twenty-three statements, no joins, run inside the caller's tenant transaction — so RLS scopes them
 * and `organization_id` never appears in a predicate here. That is deliberate: the policy is the
 * filter, and duplicating it in the query would make a missing policy invisible.
 *
 * ## The two collections that arrived late, and the field that came with them
 *
 * `moh_class` and `voicemail_greeting` are declared OPTIONAL on `OrgRoutingSnapshot` and listed in
 * `OPTIONAL_SNAPSHOT_COLLECTIONS` — a rollout affordance `packages/routing` created precisely so
 * it could ship before this loader caught up (README §4.1, §7 item 2). They are loaded now, along
 * with `voicemail_box.pin_hash`, and the three of them together are what make the compiler's
 * embeddings fire rather than degrade:
 *
 * - `mohClasses` turns every `moh_class_id` in the snapshot into the NAME a media server accepts,
 *   at compile time, so no database round trip sits on the hold path. Until it was loaded,
 *   `mohClassName` returned `undefined` for every reference AND — deliberately — raised no
 *   `dangling-moh-class` warnings, because "the loader has not learned this table" and "this
 *   tenant has four broken references" must not look the same in the diagnostics.
 * - `voicemailGreetings` gives each mailbox its own recorded greeting, as `object://<objectKey>`,
 *   instead of the media server's generic `ENGINE_VOICEMAIL_GREETING`.
 * - `pinHash` is the digest the engine verifies a caller's `*97` digits against. Until it was
 *   loaded the compiler embedded none, and a mailbox authenticated by the calling extension alone
 *   — which is to say, not at all, to anyone who can reach a handset.
 *
 * Adding collections moves every organization's `snapshotHash` exactly once, on the first compile
 * after this deploy: the hash covers the canonicalized snapshot and an absent optional collection
 * hashes as `[]`, so a tenant that has no MOH classes and no greetings hashes identically before
 * and after. Only tenants that actually have rows recompile to a different artifact, which is the
 * behaviour you want from a loader that just learned to see them.
 *
 * Greetings are loaded WHOLE — inactive rows included — for the same reason disabled rows are:
 * `active` is a routing fact the compiler owns (`indexVoicemailGreetings` sorts by id and keeps the
 * first active row per box/kind, so the artifact is deterministic whatever order arrives), and a
 * `where active` here would hand the compiler a pre-made decision it is supposed to make.
 *
 * `pagingGroups` arrived the same way and is loaded on the same terms: OPTIONAL on
 * `OrgRoutingSnapshot`, so the compiler shipped `*81` before this loader could see a group, and
 * until it could, `params.groupId` resolved to nothing and every page compiled to a code that
 * announces into an empty room. Its two statements are the group and its members; the projection
 * below explains why the members are the one child collection this file nests rather than passes
 * through flat.
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
		pagingGroups,
		pagingGroupMembers,
		featureCodes,
		callBlockRules,
		mohClasses,
		voicemailGreetings,
		emergencyAddresses,
		settingRows,
		callFlows,
		pinSets,
		pinSetEntries,
		translationRulesets,
		translationRules,
		destinationAliases,
		audioStreams,
		prompts,
		phraseSteps,
		directories,
		speedDials,
		limitRows,
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
		transaction.select().from(pagingGroup),
		transaction.select().from(pagingGroupMember),
		transaction.select().from(featureCode),
		transaction.select().from(callBlockRule),
		transaction.select().from(mohClass),
		transaction.select().from(voicemailGreeting),
		transaction.select().from(emergencyAddress),
		transaction.select().from(orgSetting).where(eq(orgSetting.category, ROUTING_SETTINGS_CATEGORY)),
		// The T2 admin block. Eleven more statements on the same connection inside the same
		// transaction, pipelined by postgres.js like the twenty-three above them, and every one of
		// them unfiltered and unjoined per the two rules in this file's header.
		transaction.select().from(callFlow),
		transaction.select().from(pinSet),
		transaction.select().from(pinSetEntry),
		transaction.select().from(translationRuleset),
		transaction.select().from(translationRule),
		transaction.select().from(destinationAlias),
		transaction.select().from(audioStream),
		transaction.select().from(prompt),
		transaction.select().from(phraseStep),
		transaction.select().from(dialByNameDirectory),
		transaction.select().from(speedDial),
		// The organization's quota row. A SINGLETON — `org_limit_organization_key` makes it at most
		// one — folded into `settings` below rather than carried as a collection, for the reason
		// `RoutingSettingsInput.maxConcurrentCalls` gives: `canonicalizeSnapshot` hashes `settings`
		// on an explicit line and a new top-level field would be silently outside the hash.
		transaction.select().from(orgLimit),
	]);

	return {
		organizationId,
		settings: readRoutingSettings(settingRows, limitRows[0]),
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
			followMe: row.followMe ?? undefined,
			/**
			 * `?? undefined`, not the raw column, and the difference is the whole point of the field.
			 *
			 * `ExtensionInput.pickupGroup` distinguishes "in no group" (absent → org-wide pickup,
			 * the fallback every extension had before groups existed) from "in group X". NULL is the
			 * first of those, so it must arrive as ABSENT rather than as `null`. The compiler's
			 * `pickupGroupOf` trims and drops blanks as a backstop, and the DTO refuses to store a
			 * whitespace-only name — but a loader that leaned on either would be relying on somebody
			 * else's normalisation to say what this tenant's phones do.
			 */
			pickupGroup: row.pickupGroup ?? undefined,
			/**
			 * Raw, not `?? undefined`: the column is `notNull().default(false)`, so there is no third
			 * state to preserve. "Screening is off" and "the operator has not thought about screening"
			 * are the same fact about how this extension answers a call, and the compiler is entitled
			 * to read a boolean as a boolean.
			 */
			callScreening: row.callScreening,
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
			// The DID's dispatchable location. The compiler picks the organization's ELIN from the
			// numbers that carry one and whose address the carrier has validated.
			emergencyAddressId: row.emergencyAddressId,
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
			inboundTranslationRulesetId: row.inboundTranslationRulesetId,
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
			pinSetId: row.pinSetId,
			translationRulesetId: row.translationRulesetId,
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
			override: row.override,
			overrideFeatureCode: row.overrideFeatureCode,
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
			recordPolicy: row.recordPolicy,
			exitKey: row.exitKey,
			exitDestinationType: row.exitDestinationType,
			exitDestinationRef: row.exitDestinationRef,
			exitDestinationData: row.exitDestinationData,
			defaultPriority: row.defaultPriority,
			abandonedResumeAllowed: row.abandonedResumeAllowed,
			discardAbandonedAfterSeconds: row.discardAbandonedAfterSeconds,
			timeoutDestinationType: row.timeoutDestinationType,
			timeoutDestinationRef: row.timeoutDestinationRef,
			timeoutDestinationData: row.timeoutDestinationData,
			/**
			 * `?? undefined` for the reason `pickupGroup` documents above: the column is nullable and
			 * `QueueInput.agentWhisperPromptId` is OPTIONAL, so NULL means "no whisper" and must arrive
			 * as absent. Passing `null` through would be a queue that whispers a prompt it does not
			 * have — or, in the compiler's terms, a `dangling-prompt` diagnostic for a reference nobody
			 * made.
			 */
			agentWhisperPromptId: row.agentWhisperPromptId ?? undefined,
		})),
		voicemailBoxes: voicemailBoxes.map((row) => ({
			id: row.id,
			enabled: row.enabled,
			mailboxNumber: row.mailboxNumber,
			label: row.label,
			extensionId: row.extensionId,
			mwiEnabled: row.mwiEnabled,
			maxMessageSeconds: row.maxMessageSeconds,
			// The one secret-shaped field in the snapshot, and the only one the engine cannot do
			// without: `*97` authentication happens on the call path, in a process with no database
			// handle. `packages/routing` parses it and refuses to embed a digest it cannot read
			// (`invalid-pin-hash`, a warning), so a malformed value costs the mailbox its PIN rather
			// than the tenant its routing.
			pinHash: row.pinHash,
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
			recordPolicy: row.recordPolicy,
			// The three flags that decide what a room SOUNDS like when somebody arrives. Until they
			// were loaded, `announce_join_leave` was a column a tenant could set, an API could write
			// and nothing could read — the snapshotHash was identical with it on or off, so the
			// artifact never changed and the engine never learned.
			entryToneEnabled: row.entryToneEnabled,
			exitToneEnabled: row.exitToneEnabled,
			announceJoinLeave: row.announceJoinLeave,
			// Both digests, for the same reason `voicemail_box.pin_hash` is loaded: the gate is
			// applied on the call path by a process with no database handle. `packages/routing`
			// parses them and refuses to embed one it cannot read — and, unlike a mailbox, a room
			// whose digest is unreadable is REFUSED rather than opened.
			pinHash: row.pinHash,
			moderatorPinHash: row.moderatorPinHash,
			// Until this was loaded, setting a moderator PIN recompiled to an identical
			// `snapshotHash`: the column was written, stored, and read by nothing.
			requiresModeratorPin: row.moderatorPinHash !== null,
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
		/**
		 * The one collection whose children are NESTED rather than flat, and not by this loader's
		 * choice: `PagingGroupInput.members` is declared that way, and the reason is recorded on the
		 * type — a member is an `(extension, position)` pair with no id anything can point at, so a
		 * second top-level collection for it would buy a `SNAPSHOT_COLLECTIONS` entry and a
		 * cache-invalidation entry in exchange for expressing a list.
		 *
		 * The read is still two flat statements and no join, which is rule 2: the grouping happens
		 * here, in memory, over rows RLS already scoped. Members arrive in ordinal order because the
		 * loader sorts them — the compiler sorts by `ordinal` again on its own side, and both are
		 * true statements about determinism rather than one relying on the other.
		 *
		 * Disabled groups and disabled members are both loaded, per rule 1. A member switched off is
		 * a fact the compiler keeps by dropping it from the compiled fan-out, not by never seeing it.
		 */
		pagingGroups: pagingGroups.map((row) => ({
			id: row.id,
			enabled: row.enabled,
			name: row.name,
			extensionNumber: row.extensionNumber,
			duplex: row.duplex,
			timeoutSeconds: row.timeoutSeconds,
			members: pagingGroupMembers
				.filter((member) => member.pagingGroupId === row.id)
				.sort((left, right) => left.ordinal - right.ordinal || (left.id < right.id ? -1 : 1))
				.map((member) => ({
					extensionId: member.extensionId,
					ordinal: member.ordinal,
					enabled: member.enabled,
				})),
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
		/**
		 * The name is the only column routing reads: every `mohClassId` in this snapshot is a row
		 * id and every media server addresses a class by name. The stream URI, the sample rate and
		 * the file list belong to the media server's provisioning, not to a routing decision.
		 */
		mohClasses: mohClasses.map((row) => ({
			id: row.id,
			enabled: row.enabled,
			name: row.name,
		})),
		voicemailGreetings: voicemailGreetings.map((row) => ({
			id: row.id,
			voicemailBoxId: row.voicemailBoxId,
			kind: row.kind,
			objectKey: row.objectKey,
			active: row.active,
			durationMs: row.durationMs,
			label: row.label,
		})),
		/**
		 * Three columns of `emergency_address`, and deliberately not the address itself.
		 *
		 * The compiler needs to answer exactly two questions — "does this DID's address exist?" and
		 * "has the carrier validated it?" — and the artifact is written to a KV bucket every engine
		 * instance can read. Carrying a tenant's street addresses there would be a liability with no
		 * routing upside; the label is there so a diagnostic can name the address a human recognises.
		 */
		emergencyAddresses: emergencyAddresses.map((row) => ({
			id: row.id,
			label: row.label,
			validated: row.validated,
		})),

		// --- the T2 admin block ------------------------------------------------------------------
		callFlows: callFlows.map((row) => ({
			id: row.id,
			enabled: row.enabled,
			name: row.name,
			extensionNumber: row.extensionNumber,
			featureCode: row.featureCode,
			mode: row.mode,
			destinationType: row.destinationType,
			destinationRef: row.destinationRef,
			destinationData: row.destinationData,
			nightDestinationType: row.nightDestinationType,
			nightDestinationRef: row.nightDestinationRef,
			nightDestinationData: row.nightDestinationData,
		})),
		pinSets: pinSets.map((row) => ({
			id: row.id,
			enabled: row.enabled,
			name: row.name,
			promptId: row.promptId,
			failurePromptId: row.failurePromptId,
			maxAttempts: row.maxAttempts,
			digitTimeoutMs: row.digitTimeoutMs,
		})),
		/**
		 * The digests travel, and this is the second place in this loader that carries one.
		 *
		 * The same rule `voicemail_box.pin_hash` follows and for the same reason: the engine
		 * challenges the caller on the call path, in a process holding no database handle, so the
		 * digest is in the artifact or the gate cannot exist. `label` and `ordinal` come with it
		 * because they are what a CDR records — the digits never are.
		 */
		pinSetEntries: pinSetEntries.map((row) => ({
			id: row.id,
			enabled: row.enabled,
			pinSetId: row.pinSetId,
			ordinal: row.ordinal,
			label: row.label,
			pinHash: row.pinHash,
		})),
		translationRulesets: translationRulesets.map((row) => ({
			id: row.id,
			enabled: row.enabled,
			name: row.name,
		})),
		translationRules: translationRules.map((row) => ({
			id: row.id,
			enabled: row.enabled,
			translationRulesetId: row.translationRulesetId,
			ordinal: row.ordinal,
			label: row.label,
			matchPattern: row.matchPattern,
			replacement: row.replacement,
		})),
		destinationAliases: destinationAliases.map((row) => ({
			id: row.id,
			enabled: row.enabled,
			name: row.name,
			destinationType: row.destinationType,
			destinationRef: row.destinationRef,
			destinationData: row.destinationData,
		})),
		audioStreams: audioStreams.map((row) => ({
			id: row.id,
			enabled: row.enabled,
			name: row.name,
			url: row.url,
			answerFirst: row.answerFirst,
			maxSeconds: row.maxSeconds,
			fallbackDestinationType: row.fallbackDestinationType,
			fallbackDestinationRef: row.fallbackDestinationRef,
			fallbackDestinationData: row.fallbackDestinationData,
		})),
		/**
		 * Three columns of the media library, and no more.
		 *
		 * The compiler needs to know which prompt ids are PHRASES (so it can expand them) and which
		 * are audio (so it can refuse a nested phrase). The object key, the duration and the checksum
		 * belong to the media layer; nothing about them changes a routing decision, and shipping a
		 * tenant's whole file list into a KV bucket every engine can read would be a cost with no
		 * routing upside.
		 */
		prompts: prompts.map((row) => ({
			id: row.id,
			// `prompt` has no `enabled` column — a file is present or it is not — so every row is
			// enabled. Stated here rather than left to a reader wondering where the column went.
			enabled: true,
			name: row.name,
			kind: row.kind,
		})),
		phraseSteps: phraseSteps.map((row) => ({
			id: row.id,
			enabled: row.enabled,
			phraseId: row.phraseId,
			promptId: row.promptId,
			ordinal: row.ordinal,
		})),
		directories: directories.map((row) => ({
			id: row.id,
			enabled: row.enabled,
			name: row.name,
			extensionNumber: row.extensionNumber,
			searchField: row.searchField,
			minDigits: row.minDigits,
			greetingPromptId: row.greetingPromptId,
			invalidPromptId: row.invalidPromptId,
			maxFailures: row.maxFailures,
			timeoutDestinationType: row.timeoutDestinationType,
			timeoutDestinationRef: row.timeoutDestinationRef,
			timeoutDestinationData: row.timeoutDestinationData,
		})),
		speedDials: speedDials.map((row) => ({
			id: row.id,
			enabled: row.enabled,
			code: row.code,
			label: row.label,
			destinationType: row.destinationType,
			destinationRef: row.destinationRef,
			destinationData: row.destinationData,
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

/** The one column of `org_limit` that routing reads. The other three are enforced at create. */
interface LimitRow {
	readonly maxConcurrentCalls: number | null;
}

/**
 * Projects `org_setting` rows — and the organization's single `org_limit` row — onto
 * {@link RoutingSettingsInput}.
 *
 * Only the names the compiler declares are read; anything else in the `routing` category is
 * ignored rather than passed through, so a stray row cannot change how calls are routed. A
 * disabled row is treated as absent, which is what the settings cascade means by `enabled`.
 *
 * ## Two tables, one settings object
 *
 * `org_limit` is a different table with a different write surface and a different grant
 * (`org-limits.write`, owner-only until W14), and it lands here anyway. The reason is the hash:
 * `canonicalizeSnapshot` names `settings` on an explicit line and derives the rest from
 * `SNAPSHOT_COLLECTIONS`, so a top-level sibling would be outside `snapshotHash` — the same
 * dead-column trap this file's header describes for `announce_join_leave` and `pin_hash`, moved up a
 * level and correspondingly harder to notice. Both tables map to the `settings` entity kind in
 * `ROUTING_TABLE_TO_ENTITY`, so a write to either evicts and recompiles once.
 *
 * Three of the four limits are absent on purpose. `maxExtensions`, `maxTrunks` and `maxStorageMb`
 * are enforced at CREATE, in the transaction that inserts the row — there is a row to refuse and a
 * person to tell. Compiling them would put a number in the artifact that nothing reads, which is
 * the trap running in the other direction.
 */
export function readRoutingSettings(
	rows: readonly SettingRow[],
	limits?: LimitRow,
): RoutingSettingsInput {
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
	const emergencyNumbers = byName.get("emergencyNumbers");

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
		// Additive to the compiled-in NANP set, never replacing it: there is deliberately no setting
		// that can remove `911` from an organization's dial plan.
		...(Array.isArray(emergencyNumbers)
			? {
					emergencyNumbers: emergencyNumbers.filter(
						(entry): entry is string => typeof entry === "string",
					),
				}
			: {}),
		// NULL is unlimited and so is a missing row, and the two are collapsed to an ABSENT KEY
		// rather than to `null` — the compiler reads both the same way, and an absent key keeps the
		// canonical snapshot of a tenant with no quota row byte-identical to what it was before this
		// column was loaded. Which is what makes adding it a no-op for every tenant that has none.
		...(limits?.maxConcurrentCalls === undefined || limits.maxConcurrentCalls === null
			? {}
			: { maxConcurrentCalls: limits.maxConcurrentCalls }),
	};
}
