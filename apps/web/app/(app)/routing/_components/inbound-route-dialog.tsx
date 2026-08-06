"use client";

import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { DestinationPicker } from "~/components/pbx/destination-picker";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { ResourceSelect } from "~/components/pbx/resource-select";
import { SelectField, SwitchField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { ROUTE_MATCH_KINDS } from "~/lib/pbx/contracts";
import {
	EMPTY_DESTINATION,
	readDestination,
	validateDestinationValue,
	writeDestination,
	type DestinationValue,
} from "~/lib/pbx/destinations";
import { inboundRouteFormSchema, type InboundRouteFormValues } from "~/lib/pbx/schemas";
import { usePbxCreate, usePbxUpdate } from "../../_hooks/use-pbx-queries";
import type { InboundRouteRow, RouteMatchKind } from "~/lib/pbx/contracts";

/**
 * Create and edit an inbound route.
 *
 * This is the form most likely to meet `ROUTING_COMPILE_FAILED`: a route names a destination, and
 * compile-on-write refuses — and ROLLS BACK — a save that would leave one dangling. The dialog's
 * shell renders that as a "Not saved" banner and this form attaches each diagnostic to the field
 * its `path` names, which for a destination is `destinationRef` or `failoverDestinationRef`.
 *
 * Match order matters and is not obvious: routes are sorted `(priority asc, specificity desc,
 * id asc)`, so a lower priority number wins and a route narrowed to one DID beats a pattern at
 * the same priority. The field descriptions say so, because a route that never fires looks
 * identical to a route that was never saved.
 */
const MATCH_KIND_LABELS: Readonly<Record<RouteMatchKind, string>> = {
	exact: "Exactly this number",
	prefix: "Numbers starting with",
	regex: "A regular expression",
	any: "Any inbound call",
};

function defaultsFor(route: InboundRouteRow | null): InboundRouteFormValues {
	return {
		name: route?.name ?? "",
		priority: route?.priority === undefined ? "" : String(route.priority),
		matchKind: route?.matchKind ?? "exact",
		matchPattern: route?.matchPattern ?? "",
		phoneNumberId: route?.phoneNumberId ?? "",
		callerIdPattern: route?.callerIdPattern ?? "",
		timeConditionId: route?.timeConditionId ?? "",
		recordEnabled: route?.recordEnabled ?? false,
		enabled: route?.enabled ?? true,
	};
}

export function InboundRouteDialog({
	open,
	onOpenChange,
	route,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	route: InboundRouteRow | null;
}) {
	const create = usePbxCreate(PBX_RESOURCES.inboundRoutes);
	const update = usePbxUpdate(PBX_RESOURCES.inboundRoutes);
	const mutation = route === null ? create : update;
	const server = useServerFieldErrors();

	const asRow = route as unknown as Record<string, unknown> | null;
	const initialPrimary = route ? readDestination(asRow, "") : EMPTY_DESTINATION;
	const initialFailover = route ? readDestination(asRow, "failover") : EMPTY_DESTINATION;

	const [primary, setPrimary] = useState<DestinationValue>(initialPrimary);
	const [failover, setFailover] = useState<DestinationValue>(initialFailover);
	const [localErrors, setLocalErrors] = useState<Readonly<Record<string, string>>>({});

	const form = useForm({
		defaultValues: defaultsFor(route),
		validators: { onSubmit: inboundRouteFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = inboundRouteFormSchema.parse(value);
			server.clear();

			const problems: Record<string, string> = {};
			const primaryProblem = validateDestinationValue(primary, { required: true });
			if (primaryProblem) {
				problems[`destination${capitalize(primaryProblem.field)}`] = primaryProblem.message;
			}
			const failoverProblem = validateDestinationValue(failover, { required: false });
			if (failoverProblem) {
				problems[`failoverDestination${capitalize(failoverProblem.field)}`] =
					failoverProblem.message;
			}
			if (Object.keys(problems).length > 0) {
				setLocalErrors(problems);
				return;
			}
			setLocalErrors({});

			const body = {
				name: parsed.name,
				priority: parsed.priority ?? undefined,
				matchKind: parsed.matchKind,
				matchPattern: parsed.matchPattern,
				phoneNumberId: parsed.phoneNumberId === "" ? null : parsed.phoneNumberId,
				callerIdPattern: parsed.callerIdPattern,
				timeConditionId: parsed.timeConditionId === "" ? null : parsed.timeConditionId,
				recordEnabled: parsed.recordEnabled,
				enabled: parsed.enabled,
				...writeDestination(primary, ""),
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
					setPrimary(initialPrimary);
					setFailover(initialFailover);
					form.reset();
				}
				onOpenChange(next);
			}}
			title={route === null ? "New inbound route" : `Edit ${route.name}`}
			description="Which arriving calls this claims, and where it sends them."
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
							placeholder="Main line"
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
							description="Lowest first. At equal priority, the more specific route wins."
							disabled={mutation.isPending}
							submitError={errors.priority}
						/>
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
				<form.Field name="matchPattern">
					{(field) => (
						<TextField
							field={field}
							label="Pattern"
							placeholder="+1212555"
							disabled={mutation.isPending}
							submitError={errors.matchPattern}
						/>
					)}
				</form.Field>
				<form.Field name="phoneNumberId">
					{(field) => (
						<ResourceSelect
							id="phoneNumberId"
							label="Only for this number"
							resource={PBX_RESOURCES.phoneNumbers}
							value={field.state.value}
							onChange={(next) => field.handleChange(next)}
							emptyLabel="Any number"
							description="Narrowing to one DID beats a pattern at the same priority."
							disabled={mutation.isPending}
							error={errors.phoneNumberId}
						/>
					)}
				</form.Field>
				<form.Field name="callerIdPattern">
					{(field) => (
						<TextField
							field={field}
							label="Only from callers matching"
							placeholder="+1415"
							description="Optional. Lets one number route differently by who is calling."
							disabled={mutation.isPending}
							submitError={errors.callerIdPattern}
						/>
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
							description="A gate: outside the condition's rules, this route does not apply at all."
							disabled={mutation.isPending}
							error={errors.timeConditionId}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
			</FormSection>

			<DestinationPicker
				prefix=""
				label="Sends the call to"
				value={primary}
				onChange={(next) => {
					setPrimary(next);
					setLocalErrors({});
				}}
				required
				disabled={mutation.isPending}
				errors={errors}
			/>

			<DestinationPicker
				prefix="failover"
				label="If that fails"
				description="Taken when the destination above cannot take the call at all."
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
					{(field) => (
						<SwitchField
							field={field}
							label="Enabled"
							description="A disabled route is skipped entirely; the next matching route claims the call."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}
