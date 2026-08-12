"use client";

import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { AttachedReference } from "~/components/pbx/attached-reference";
import { DestinationPicker } from "~/components/pbx/destination-picker";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { ResourceOrderedList, ResourceSelect } from "~/components/pbx/resource-select";
import { SelectField, SwitchField, TextareaField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { ROUTE_MATCH_KINDS, TOLL_CLASSES } from "~/lib/pbx/contracts";
import {
	EMPTY_DESTINATION,
	readDestination,
	validateDestinationValue,
	writeDestination,
	type DestinationValue,
} from "~/lib/pbx/destinations";
import { outboundRouteFormSchema, parseDialPatterns } from "~/lib/pbx/schemas";
import { usePbxCreate, usePbxUpdate } from "../../_hooks/use-pbx-queries";
import type { OutboundRouteRow, RouteMatchKind, TollClass } from "~/lib/pbx/contracts";

/**
 * Create and edit an outbound route.
 *
 * ## Toll class is the anti-fraud gate, and it has no default
 *
 * An extension may only take a route whose class its own class covers. The server refuses to
 * default it, so this form does not pre-select one either: the create form opens with the select
 * on a disabled prompt, and picking is a decision the user makes rather than one they inherit. A
 * route that quietly defaulted to `internal` would be unusable; one that defaulted to
 * `international` would be a bill.
 *
 * ## The trunks are an ordered chain, not a set
 *
 * `trunk_priority` is tried in order, so it is edited as a list with up/down rather than as a
 * multi-select — which has no order and which nobody operates with a keyboard. The form sends
 * `{ trunkId, order }` derived from the list's position, so the two can never disagree.
 */
const MATCH_KIND_LABELS: Readonly<Record<RouteMatchKind, string>> = {
	exact: "Exactly these numbers",
	prefix: "Numbers starting with these",
	regex: "Regular expressions",
	any: "Any dialled number",
};

const TOLL_CLASS_LABELS: Readonly<Record<TollClass, string>> = {
	internal: "Internal only",
	local: "Local",
	national: "National",
	international: "International",
	premium: "Premium rate",
};

interface OutboundFormState {
	name: string;
	priority: string;
	matchKind: RouteMatchKind;
	dialPatternsText: string;
	stripDigits: string;
	prependDigits: string;
	tollClass: TollClass | "";
	timeConditionId: string;
	callerIdNumberOverride: string;
	recordEnabled: boolean;
	enabled: boolean;
}

function defaultsFor(route: OutboundRouteRow | null): OutboundFormState {
	return {
		name: route?.name ?? "",
		priority: route?.priority === undefined ? "" : String(route.priority),
		matchKind: route?.matchKind ?? "prefix",
		dialPatternsText: (route?.dialPatterns ?? []).join("\n"),
		stripDigits: route?.stripDigits === undefined ? "" : String(route.stripDigits),
		prependDigits: route?.prependDigits ?? "",
		tollClass: route?.tollClass ?? "",
		timeConditionId: route?.timeConditionId ?? "",
		callerIdNumberOverride: route?.callerIdNumberOverride ?? "",
		recordEnabled: route?.recordEnabled ?? false,
		enabled: route?.enabled ?? true,
	};
}

export function OutboundRouteDialog({
	open,
	onOpenChange,
	route,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	route: OutboundRouteRow | null;
}) {
	const create = usePbxCreate(PBX_RESOURCES.outboundRoutes);
	const update = usePbxUpdate(PBX_RESOURCES.outboundRoutes);
	const mutation = route === null ? create : update;
	const server = useServerFieldErrors();

	const initialFailover = route
		? readDestination(route as unknown as Record<string, unknown>, "failover")
		: EMPTY_DESTINATION;
	const initialTrunks = (route?.trunkPriority ?? [])
		.toSorted((a, b) => a.order - b.order)
		.map((entry) => entry.trunkId);

	const [failover, setFailover] = useState<DestinationValue>(initialFailover);
	const [trunkIds, setTrunkIds] = useState<readonly string[]>(initialTrunks);
	const [localErrors, setLocalErrors] = useState<Readonly<Record<string, string>>>({});

	const form = useForm({
		defaultValues: defaultsFor(route),
		onSubmit: async ({ value }) => {
			server.clear();

			const parsed = outboundRouteFormSchema.safeParse({
				name: value.name,
				priority: value.priority,
				matchKind: value.matchKind,
				dialPatterns: parseDialPatterns(value.dialPatternsText),
				stripDigits: value.stripDigits,
				prependDigits: value.prependDigits,
				tollClass: value.tollClass,
				trunkIds: [...trunkIds],
				timeConditionId: value.timeConditionId,
				callerIdNumberOverride: value.callerIdNumberOverride,
				recordEnabled: value.recordEnabled,
				enabled: value.enabled,
			});

			if (!parsed.success) {
				const problems: Record<string, string> = {};
				for (const issue of parsed.error.issues) {
					const key = issue.path[0];
					const field = key === "dialPatterns" ? "dialPatternsText" : String(key);
					problems[field] ??= issue.message;
				}
				setLocalErrors(problems);
				return;
			}

			const failoverProblem = validateDestinationValue(failover, { required: false });
			if (failoverProblem) {
				setLocalErrors({
					[`failoverDestination${capitalize(failoverProblem.field)}`]: failoverProblem.message,
				});
				return;
			}
			setLocalErrors({});

			const body = {
				name: parsed.data.name,
				priority: parsed.data.priority ?? undefined,
				matchKind: parsed.data.matchKind,
				dialPatterns: parsed.data.dialPatterns,
				stripDigits: parsed.data.stripDigits ?? undefined,
				prependDigits: parsed.data.prependDigits,
				tollClass: parsed.data.tollClass,
				// The list's position IS the order, so the two cannot drift apart.
				trunkPriority: parsed.data.trunkIds.map((trunkId, index) => ({ trunkId, order: index })),
				timeConditionId: parsed.data.timeConditionId === "" ? null : parsed.data.timeConditionId,
				callerIdNumberOverride: parsed.data.callerIdNumberOverride,
				recordEnabled: parsed.data.recordEnabled,
				enabled: parsed.data.enabled,
				...writeDestination(failover, "failover"),
			};

			try {
				if (route === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: route.id, values: body });
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
					setFailover(initialFailover);
					setTrunkIds(initialTrunks);
					form.reset();
				}
				onOpenChange(next);
			}}
			title={route === null ? "New outbound route" : `Edit ${route.name}`}
			description="Which dialled numbers this claims, how the digits are rewritten, and which carriers it tries."
			submitLabel={route === null ? "Create route" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			size="lg"
		>
			<FormSection title="Route">
				<form.Field name="name">
					{(field) => (
						<TextField
							field={field}
							label="Name"
							required
							autoFocus={route === null}
							placeholder="National"
							disabled={mutation.isPending}
							submitError={errors.name}
						/>
					)}
				</form.Field>
				<form.Field name="priority">
					{(field) => (
						<TextField
							field={field}
							label="Priority"
							placeholder="100"
							description="Lowest first."
							disabled={mutation.isPending}
							submitError={errors.priority}
						/>
					)}
				</form.Field>
				<form.Field name="tollClass">
					{(field) => (
						<SelectField
							field={field}
							label="Toll class"
							required
							description="Only extensions at or above this class may take this route. There is no default — this is the anti-toll-fraud gate."
							disabled={mutation.isPending}
							submitError={errors.tollClass}
							className="sm:col-span-2"
						>
							<option value="" disabled>
								Choose what this route costs…
							</option>
							{TOLL_CLASSES.map((value) => (
								<option key={value} value={value}>
									{TOLL_CLASS_LABELS[value]}
								</option>
							))}
						</SelectField>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="What it claims">
				<form.Field name="matchKind">
					{(field) => (
						<SelectField
							field={field}
							label="Matches"
							disabled={mutation.isPending}
							submitError={errors.matchKind}
						>
							{ROUTE_MATCH_KINDS.map((value) => (
								<option key={value} value={value}>
									{MATCH_KIND_LABELS[value]}
								</option>
							))}
						</SelectField>
					)}
				</form.Field>
				<form.Field name="timeConditionId">
					{(field) => (
						<ResourceSelect
							id="timeConditionId"
							label="Only while this condition matches"
							resource={PBX_RESOURCES.timeConditions}
							value={field.state.value}
							onChange={(next) => field.handleChange(next)}
							emptyLabel="Always"
							disabled={mutation.isPending}
							error={errors.timeConditionId}
						/>
					)}
				</form.Field>
				<form.Field name="dialPatternsText">
					{(field) => (
						<TextareaField
							field={field}
							label="Dial patterns"
							required
							rows={4}
							placeholder={"0XXXXXXXXX\n00X."}
							description="One per line. The first that matches wins."
							disabled={mutation.isPending}
							submitError={errors.dialPatternsText}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="Digit rewriting">
				<form.Field name="stripDigits">
					{(field) => (
						<TextField
							field={field}
							label="Strip leading digits"
							placeholder="1"
							description="Removed from the front of what the user dialled."
							disabled={mutation.isPending}
							submitError={errors.stripDigits}
						/>
					)}
				</form.Field>
				<form.Field name="prependDigits">
					{(field) => (
						<TextField
							field={field}
							label="Then prepend"
							placeholder="+1"
							description="Added after stripping, before the call is handed to the trunk."
							disabled={mutation.isPending}
							submitError={errors.prependDigits}
						/>
					)}
				</form.Field>
				<form.Field name="callerIdNumberOverride">
					{(field) => (
						<TextField
							field={field}
							label="Caller ID override"
							placeholder="+12125550100"
							description="Forces every call on this route to present this number."
							disabled={mutation.isPending}
							submitError={errors.callerIdNumberOverride}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
				{/*
				 * The shared ruleset, shown where the inline pair is so the ORDER is visible: strip and
				 * prepend run first — turning what somebody's fingers did into the number they meant — and
				 * the ruleset second, normalising that number for the wire. A ruleset that ran first would
				 * have to know about every route's outside-line prefix, which is the coupling the shared
				 * layer exists to remove.
				 */}
				<AttachedReference
					label="Then apply the shared ruleset"
					resource={PBX_RESOURCES.translationRulesets}
					value={route?.translationRulesetId ?? null}
					emptyLabel="No shared ruleset — the number goes to the carrier as the two fields above left it."
					description="Runs after the strip and prepend above, on the number they produced."
					note="Attaching a ruleset is not editable from this application yet: the column exists and the compiler reads it, but no endpoint accepts it in a request body."
				/>
			</FormSection>

			<FormSection title="Authorisation" columns={1}>
				<AttachedReference
					label="Codes demanded before dialling"
					resource={PBX_RESOURCES.pinSets}
					value={route?.pinSetId ?? null}
					emptyLabel="No challenge — anyone whose toll class covers this route may dial it."
					description="A caller is asked for a code before any trunk is offered the call, and the code that answered is recorded against the call."
					note="Attaching a PIN set is not editable from this application yet: the column exists and the compiler reads it, but no endpoint accepts it in a request body."
				/>
			</FormSection>

			<FormSection title="Carriers" columns={1}>
				<ResourceOrderedList
					id="trunkPriority"
					label="Trunks, in the order they are tried"
					resource={PBX_RESOURCES.trunks}
					value={trunkIds}
					onChange={(next) => {
						setTrunkIds(next);
						setLocalErrors({});
					}}
					description="The first trunk that accepts the call carries it. A route with no trunks compiles, but every call on it fails."
					disabled={mutation.isPending}
					error={errors.trunkIds ?? errors.trunkPriority}
				/>
			</FormSection>

			<DestinationPicker
				prefix="failover"
				label="If every trunk fails"
				description="Where the call goes when no carrier could take it — a voicemail box, or a hangup with a cause."
				value={failover}
				onChange={(next) => {
					setFailover(next);
					setLocalErrors({});
				}}
				disabled={mutation.isPending}
				errors={errors}
			/>

			<FormSection title="Behaviour" columns={1}>
				<form.Field name="recordEnabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Record calls on this route"
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
				<form.Field name="enabled">
					{(field) => <SwitchField field={field} label="Enabled" disabled={mutation.isPending} />}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}
