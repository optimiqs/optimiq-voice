"use client";

import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { DestinationPicker } from "~/components/pbx/destination-picker";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { PromptSelect, ResourceSelect } from "~/components/pbx/resource-select";
import { SelectField, SwitchField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { QUEUE_STRATEGIES, RECORD_POLICIES } from "~/lib/pbx/contracts";
import {
	EMPTY_DESTINATION,
	readDestination,
	validateDestinationValue,
	writeDestination,
	type DestinationValue,
} from "~/lib/pbx/destinations";
import { queueFormSchema, type QueueFormValues } from "~/lib/pbx/schemas";
import { usePbxCreate, usePbxUpdate } from "../../_hooks/use-pbx-queries";
import type { QueueRow, QueueStrategy, RecordPolicy } from "~/lib/pbx/contracts";

/**
 * A queue's settings: how it distributes calls, how long it holds them, and where they go when it
 * runs out of patience.
 *
 * This dialog is gated on `queues.write` and nothing here staffs the queue. Who answers it is a
 * TIER, which is `queues.manage-agents` — a supervisor who staffs the floor is not necessarily the
 * person who may re-point the overflow at an external number, and the API keeps the two apart on
 * purpose. So does this: the agents and tier surfaces are elsewhere, and their buttons ask for the
 * other grant.
 */
const STRATEGY_LABELS: Readonly<Record<QueueStrategy, string>> = {
	"longest-idle": "Offer to whoever has waited longest",
	"ring-all": "Ring every available agent at once",
	"round-robin": "Take turns, in tier order",
	"top-down": "Always start at the top of the tier",
	sequential: "One agent after another",
	random: "Pick an available agent at random",
};

/**
 * The recording vocabulary, said in the QUEUE's terms rather than the extension's.
 *
 * The set is the same five `extension` and `trunk` carry — one policy, one spelling, which is why
 * the boolean this replaced had to go — but the labels are not the extension dialog's, because
 * `outbound` means something different here and saying "Outbound calls" would offer an operator a
 * setting that does nothing. A queued call is INBOUND from the queue's point of view whichever
 * direction the leg that reached it was travelling, so `outbound` never records anything a queue
 * distributed, and the label says so rather than letting somebody discover it from an empty
 * recordings list.
 */
const RECORD_POLICY_LABELS: Readonly<Record<RecordPolicy, string>> = {
	none: "Never record",
	inbound: "Record the calls this queue answers",
	outbound: "Outbound only — which records nothing here",
	all: "Record everything, which here is the same as inbound",
	"on-demand": "Only when the agent starts it by hand",
};

function defaultsFor(queue: QueueRow | null): QueueFormValues {
	/** Every numeric knob renders as text, because an emptied one has to reach the server as `null`. */
	const numeric = (value: number | undefined): string => (value === undefined ? "" : String(value));
	return {
		name: queue?.name ?? "",
		extensionNumber: queue?.extensionNumber ?? "",
		strategy: queue?.strategy ?? "longest-idle",
		mohClassId: queue?.mohClassId ?? "",
		greetingPromptId: queue?.greetingPromptId ?? "",
		announcePromptId: queue?.announcePromptId ?? "",
		agentWhisperPromptId: queue?.agentWhisperPromptId ?? "",
		maxWaitSeconds: numeric(queue?.maxWaitSeconds),
		maxWaitNoAgentSeconds: numeric(queue?.maxWaitNoAgentSeconds),
		wrapUpSeconds: numeric(queue?.wrapUpSeconds),
		announcePositionEnabled: queue?.announcePositionEnabled ?? false,
		announceFrequencySeconds: numeric(queue?.announceFrequencySeconds),
		abandonedResumeAllowed: queue?.abandonedResumeAllowed ?? false,
		discardAbandonedAfterSeconds: numeric(queue?.discardAbandonedAfterSeconds),
		tierRulesApply: queue?.tierRulesApply ?? true,
		tierRuleWaitSeconds: numeric(queue?.tierRuleWaitSeconds),
		tierRuleNoAgentNoWait: queue?.tierRuleNoAgentNoWait ?? false,
		recordPolicy: queue?.recordPolicy ?? "none",
		exitKey: queue?.exitKey ?? "",
		defaultPriority: numeric(queue?.defaultPriority),
		enabled: queue?.enabled ?? true,
	};
}

export function QueueDialog({
	open,
	onOpenChange,
	queue,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	queue: QueueRow | null;
}) {
	const create = usePbxCreate(PBX_RESOURCES.queues);
	const update = usePbxUpdate(PBX_RESOURCES.queues);
	const mutation = queue === null ? create : update;
	const server = useServerFieldErrors();

	const initialTimeout = queue
		? readDestination(queue as unknown as Record<string, unknown>, "timeout")
		: EMPTY_DESTINATION;
	const initialExit = queue
		? readDestination(queue as unknown as Record<string, unknown>, "exit")
		: EMPTY_DESTINATION;
	const [timeoutDestination, setTimeoutDestination] = useState<DestinationValue>(initialTimeout);
	const [exitDestination, setExitDestination] = useState<DestinationValue>(initialExit);
	const [localErrors, setLocalErrors] = useState<Readonly<Record<string, string>>>({});

	const form = useForm({
		defaultValues: defaultsFor(queue),
		validators: { onSubmit: queueFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = queueFormSchema.parse(value);
			server.clear();

			/**
			 * Both optional trios, checked in one pass so the first incomplete one is the one named.
			 *
			 * The exit destination is checked even when there is no exit key: a destination chosen and
			 * then left half-filled is a 422 either way, and refusing it here puts the message on the
			 * control rather than on the round trip. The reverse pairing — a key with nowhere to go —
			 * is a WARNING rather than an error, and it is said beside the key itself, because the
			 * server accepts it and the engine simply drops the caller.
			 */
			const issues: Record<string, string> = {};
			for (const [prefix, value] of [
				["timeout", timeoutDestination],
				["exit", exitDestination],
			] as const) {
				const problem = validateDestinationValue(value, { required: false });
				if (problem) {
					issues[
						`${prefix}Destination${problem.field.charAt(0).toUpperCase()}${problem.field.slice(1)}`
					] = problem.message;
				}
			}
			if (Object.keys(issues).length > 0) {
				setLocalErrors(issues);
				return;
			}
			setLocalErrors({});

			/**
			 * Every numeric knob is `resettable` on the server: `null` puts it back to the server
			 * default rather than clearing it to NULL, which is what "leave it empty" means on a column
			 * that is `notNull().default(n)`. `undefined` would leave the stored value alone on a
			 * PATCH, which is a different intent and not the one an emptied input expresses.
			 *
			 * The four audio selectors send `null` too, and it means the other thing: those columns
			 * ARE nullable, so an emptied one clears the class or prompt rather than restoring a
			 * default. Same value on the wire, opposite effect, and the difference is the column's.
			 */
			const body = {
				name: parsed.name,
				extensionNumber: parsed.extensionNumber,
				strategy: parsed.strategy,
				mohClassId: parsed.mohClassId,
				greetingPromptId: parsed.greetingPromptId,
				announcePromptId: parsed.announcePromptId,
				agentWhisperPromptId: parsed.agentWhisperPromptId,
				maxWaitSeconds: parsed.maxWaitSeconds,
				maxWaitNoAgentSeconds: parsed.maxWaitNoAgentSeconds,
				wrapUpSeconds: parsed.wrapUpSeconds,
				announcePositionEnabled: parsed.announcePositionEnabled,
				announceFrequencySeconds: parsed.announceFrequencySeconds,
				abandonedResumeAllowed: parsed.abandonedResumeAllowed,
				discardAbandonedAfterSeconds: parsed.discardAbandonedAfterSeconds,
				tierRulesApply: parsed.tierRulesApply,
				tierRuleWaitSeconds: parsed.tierRuleWaitSeconds,
				tierRuleNoAgentNoWait: parsed.tierRuleNoAgentNoWait,
				recordPolicy: parsed.recordPolicy,
				exitKey: parsed.exitKey,
				defaultPriority: parsed.defaultPriority,
				enabled: parsed.enabled,
				...writeDestination(timeoutDestination, "timeout"),
				...writeDestination(exitDestination, "exit"),
			};

			try {
				if (queue === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: queue.id, values: body });
				}
				form.reset();
				onOpenChange(false);
			} catch (error) {
				server.capture(error);
			}
		},
	});

	const errors = { ...server.errors, ...localErrors };

	return (
		<EntityFormDialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					server.clear();
					mutation.reset();
					setLocalErrors({});
					setTimeoutDestination(initialTimeout);
					setExitDestination(initialExit);
					form.reset();
				}
				onOpenChange(next);
			}}
			title={queue === null ? "New queue" : `Edit ${queue.name}`}
			description="How the queue distributes calls, how long it holds them, and where they go if it cannot."
			submitLabel={queue === null ? "Create queue" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			size="lg"
			footerNote={
				queue === null
					? "Agents are staffed on the queue's page once it exists, and that is a separate permission. A queue with nobody in it holds callers until the wait cap and then takes the timeout destination."
					: "Hold music and the three prompts are chosen from the media library. Audio has to be uploaded there before it appears in these lists."
			}
		>
			<FormSection title="Queue">
				<form.Field name="name">
					{(field) => (
						<TextField
							field={field}
							label="Name"
							required
							autoFocus={queue === null}
							placeholder="Support"
							disabled={mutation.isPending}
							submitError={errors.name}
						/>
					)}
				</form.Field>
				<form.Field name="extensionNumber">
					{(field) => (
						<TextField
							field={field}
							label="Internal number"
							placeholder="7000"
							description="Optional. Lets staff dial the queue directly."
							disabled={mutation.isPending}
							submitError={errors.extensionNumber}
						/>
					)}
				</form.Field>
				<form.Field name="strategy">
					{(field) => (
						<SelectField
							field={field}
							label="Distribution"
							required
							description="Which staffed agent the next call is offered to."
							disabled={mutation.isPending}
							submitError={errors.strategy}
							className="sm:col-span-2"
						>
							{QUEUE_STRATEGIES.map((value) => (
								<option key={value} value={value}>
									{STRATEGY_LABELS[value]}
								</option>
							))}
						</SelectField>
					)}
				</form.Field>
				<form.Field name="defaultPriority">
					{(field) => (
						<TextField
							field={field}
							label="Starting priority"
							placeholder="0"
							description="0–1000, and higher is answered first. Whatever sends the call here can override it — an IVR option for platinum customers is exactly that."
							disabled={mutation.isPending}
							submitError={errors.defaultPriority}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection
				title="Waiting"
				description="Both caps are in seconds, and 0 means no cap at all — the caller waits until they hang up."
			>
				<form.Field name="maxWaitSeconds">
					{(field) => (
						<TextField
							field={field}
							label="Give up after"
							placeholder="0"
							description="Takes the timeout destination below."
							disabled={mutation.isPending}
							submitError={errors.maxWaitSeconds}
						/>
					)}
				</form.Field>
				<form.Field name="maxWaitNoAgentSeconds">
					{(field) => (
						<TextField
							field={field}
							label="Give up when nobody is logged in"
							placeholder="0"
							description="A shorter cap for the case where waiting cannot possibly help."
							disabled={mutation.isPending}
							submitError={errors.maxWaitNoAgentSeconds}
						/>
					)}
				</form.Field>
				<form.Field name="wrapUpSeconds">
					{(field) => (
						<TextField
							field={field}
							label="Wrap-up time"
							placeholder="10"
							description="How long an agent is left alone after a call before the queue offers them another."
							disabled={mutation.isPending}
							submitError={errors.wrapUpSeconds}
						/>
					)}
				</form.Field>
				<form.Field name="discardAbandonedAfterSeconds">
					{(field) => (
						<TextField
							field={field}
							label="Forget an abandoned caller after"
							placeholder="60"
							description="How long a caller who hung up may call back and keep their place."
							disabled={mutation.isPending}
							submitError={errors.discardAbandonedAfterSeconds}
						/>
					)}
				</form.Field>
			</FormSection>

			<DestinationPicker
				prefix="timeout"
				label="When the wait runs out"
				description="Taken when either cap above expires. Leave it empty to hang up on the caller — which is rarely what anyone wants."
				value={timeoutDestination}
				onChange={(next) => {
					setTimeoutDestination(next);
					setLocalErrors({});
				}}
				disabled={mutation.isPending}
				errors={errors}
			/>

			{/*
			 * The exit key: the one control on this form that gives the CALLER a decision.
			 *
			 * Its own section rather than a field in "Waiting", because the key and where it leads are
			 * one setting in two halves — a key with nowhere to go drops the caller, and a destination
			 * with no key is unreachable. The pairing warning below says which half is missing rather
			 * than letting an operator find out from a queue that swallows callers who press 2.
			 */}
			<FormSection
				title="Letting a caller out"
				description="A waiting caller can press one key to stop holding. Leave the key empty and the queue has no exit at all, which is how every queue behaved before this existed."
				columns={1}
			>
				<form.Field name="exitKey">
					{(field) => (
						<TextField
							field={field}
							label="Exit key"
							placeholder="2"
							description="One digit: 0–9, *, # or A–D. A caller four minutes into a hold will not type a string, so there is no longer code."
							disabled={mutation.isPending}
							submitError={errors.exitKey}
						/>
					)}
				</form.Field>
				<form.Subscribe selector={(state) => state.values.exitKey}>
					{(exitKey) =>
						exitKey.trim().length > 0 && exitDestination.type === null ? (
							<p className="text-xs text-warning">
								This key has nowhere to send the caller yet. Until a destination is chosen below,
								pressing it takes them out of the line and hangs up on them.
							</p>
						) : exitKey.trim().length === 0 && exitDestination.type !== null ? (
							<p className="text-xs text-warning">
								Nothing can reach this destination without a key above, so it is configuration that
								never runs.
							</p>
						) : null
					}
				</form.Subscribe>
			</FormSection>

			<DestinationPicker
				prefix="exit"
				label="Where the exit key sends them"
				description="Usually the queue's own voicemail box, so a caller who cannot wait can still leave a message. An overflow queue, the operator or a callback IVR are the other common answers."
				value={exitDestination}
				onChange={(next) => {
					setExitDestination(next);
					setLocalErrors({});
				}}
				disabled={mutation.isPending}
				errors={errors}
			/>

			<FormSection
				title="What the caller hears"
				description="The greeting plays once, on arrival; the hold music plays under everything else until an agent picks up."
			>
				<form.Field name="mohClassId">
					{(field) => (
						<ResourceSelect
							id="queueMohClassId"
							label="Hold music"
							resource={PBX_RESOURCES.mohClasses}
							value={field.state.value}
							onChange={(next) => field.handleChange(next)}
							emptyLabel="The organization default"
							description="Plays for the whole wait, interrupted by the announcements below."
							disabled={mutation.isPending}
							error={errors.mohClassId}
						/>
					)}
				</form.Field>
				<form.Field name="greetingPromptId">
					{(field) => (
						<PromptSelect
							id="queueGreetingPromptId"
							label="Greeting"
							value={field.state.value}
							onChange={(next) => field.handleChange(next)}
							emptyLabel="Go straight to the hold music"
							description="Played once as the call joins the queue, before the wait begins."
							disabled={mutation.isPending}
							error={errors.greetingPromptId}
						/>
					)}
				</form.Field>
				<form.Field name="announcePromptId">
					{(field) => (
						<PromptSelect
							id="queueAnnouncePromptId"
							label="Periodic announcement"
							value={field.state.value}
							onChange={(next) => field.handleChange(next)}
							emptyLabel="None"
							description="Repeated at the interval below. With no prompt chosen, the interval only governs the position announcement."
							disabled={mutation.isPending}
							error={errors.announcePromptId}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
				<form.Field name="announceFrequencySeconds">
					{(field) => (
						<TextField
							field={field}
							label="Announce every (seconds)"
							placeholder="30"
							disabled={mutation.isPending}
							submitError={errors.announceFrequencySeconds}
						/>
					)}
				</form.Field>
				<form.Field name="announcePositionEnabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Tell callers their position"
							description="Read out where they are in the queue at the interval above."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>

			{/*
			 * A section of its own, and the separation is the point rather than tidiness.
			 *
			 * Everything above plays to the CALLER. This plays to the answering agent alone, in the
			 * second between them lifting the handset and saying hello, and the caller hears none of
			 * it. Filing it under "What the caller hears" would have put a control that must never
			 * reach the caller in the list of things that do — which is exactly the mistake that turns
			 * a cue sheet into the customer discovering they reached a routing table.
			 */}
			<FormSection
				title="What the agent hears"
				description="Played to whoever answers, before the caller is connected. The caller hears nothing of it."
				columns={1}
			>
				<form.Field name="agentWhisperPromptId">
					{(field) => (
						<PromptSelect
							id="queueAgentWhisperPromptId"
							label="Whisper on answer"
							value={field.state.value}
							onChange={(next) => field.handleChange(next)}
							emptyLabel="Connect the caller straight away"
							description="Played to the agent alone, before the caller is connected — usually the queue's name, so an agent staffing four queues knows which script to open with instead of guessing in front of the customer."
							disabled={mutation.isPending}
							error={errors.agentWhisperPromptId}
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection
				title="Tier rules"
				description="How the queue walks down the tiers when the level it is on does not answer."
				columns={1}
			>
				<form.Field name="tierRulesApply">
					{(field) => (
						<SwitchField
							field={field}
							label="Walk down the tiers"
							description="Off means every staffed agent is treated as one flat tier, whatever their level says."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
				<form.Field name="tierRuleWaitSeconds">
					{(field) => (
						<TextField
							field={field}
							label="Wait on each tier (seconds)"
							placeholder="10"
							description="How long a level is given before the next one is brought in."
							disabled={mutation.isPending}
							submitError={errors.tierRuleWaitSeconds}
						/>
					)}
				</form.Field>
				<form.Field name="tierRuleNoAgentNoWait">
					{(field) => (
						<SwitchField
							field={field}
							label="Skip a tier with nobody in it"
							description="Do not spend the tier wait on a level where no agent is available."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="Behaviour" columns={1}>
				<form.Field name="abandonedResumeAllowed">
					{(field) => (
						<SwitchField
							field={field}
							label="Let a caller who hung up keep their place"
							description="Within the discard window above."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
				<form.Field name="recordPolicy">
					{(field) => (
						<SelectField
							field={field}
							label="Recording"
							description="Recording starts when an agent ANSWERS, never at the join — hold music is not evidence of anything, and recording it would put every abandoned call in the retention bucket."
							disabled={mutation.isPending}
							submitError={errors.recordPolicy}
						>
							{RECORD_POLICIES.map((value) => (
								<option key={value} value={value}>
									{RECORD_POLICY_LABELS[value]}
								</option>
							))}
						</SelectField>
					)}
				</form.Field>
				<form.Field name="enabled">
					{(field) => <SwitchField field={field} label="Enabled" disabled={mutation.isPending} />}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
