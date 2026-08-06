"use client";

import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { DestinationPicker } from "~/components/pbx/destination-picker";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { PromptSelect } from "~/components/pbx/resource-select";
import { SwitchField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import {
	EMPTY_DESTINATION,
	readDestination,
	validateDestinationValue,
	writeDestination,
	type DestinationValue,
} from "~/lib/pbx/destinations";
import { ivrMenuFormSchema, type IvrMenuFormValues } from "~/lib/pbx/schemas";
import { usePbxCreate, usePbxUpdate } from "../../_hooks/use-pbx-queries";
import type { IvrMenuRow } from "~/lib/pbx/contracts";

/**
 * Create and edit an IVR menu's own settings.
 *
 * The menu carries TWO destination trios and neither is the menu's "main" one: `timeout` is where
 * a caller who says nothing goes, `invalid` is where a caller who presses something meaningless
 * goes. The options — the digits themselves — are a child collection edited on the menu's detail
 * page, because each option carries its own destination and a picker inside a picker inside a
 * dialog is not a form anyone can fill in.
 *
 * Both trios are optional here. A menu with neither is legal and compiles; it simply hangs up on
 * a caller who does nothing, which is a decision someone may have made deliberately.
 */
function defaultsFor(menu: IvrMenuRow | null): IvrMenuFormValues {
	return {
		name: menu?.name ?? "",
		extensionNumber: menu?.extensionNumber ?? "",
		digitTimeoutMs: menu?.digitTimeoutMs === undefined ? "" : String(menu.digitTimeoutMs),
		interDigitTimeoutMs:
			menu?.interDigitTimeoutMs === undefined ? "" : String(menu.interDigitTimeoutMs),
		maxDigits: menu?.maxDigits === undefined ? "" : String(menu.maxDigits),
		maxFailures: menu?.maxFailures === undefined ? "" : String(menu.maxFailures),
		maxTimeouts: menu?.maxTimeouts === undefined ? "" : String(menu.maxTimeouts),
		greetingPromptId: menu?.greetingPromptId ?? "",
		shortGreetingPromptId: menu?.shortGreetingPromptId ?? "",
		invalidPromptId: menu?.invalidPromptId ?? "",
		timeoutPromptId: menu?.timeoutPromptId ?? "",
		directDialEnabled: menu?.directDialEnabled ?? false,
		enabled: menu?.enabled ?? true,
	};
}

export function IvrMenuDialog({
	open,
	onOpenChange,
	menu,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	menu: IvrMenuRow | null;
}) {
	const create = usePbxCreate(PBX_RESOURCES.ivrMenus);
	const update = usePbxUpdate(PBX_RESOURCES.ivrMenus);
	const mutation = menu === null ? create : update;
	const server = useServerFieldErrors();

	const asRow = menu as unknown as Record<string, unknown> | null;
	const initialTimeout = menu ? readDestination(asRow, "timeout") : EMPTY_DESTINATION;
	const initialInvalid = menu ? readDestination(asRow, "invalid") : EMPTY_DESTINATION;

	// Named `timeoutDestination`, not `timeout` — a local called `setTimeout` shadows the global one,
	// which is the kind of shadowing that only bites once something in this file needs a real timer.
	const [timeoutDestination, setTimeoutDestination] = useState<DestinationValue>(initialTimeout);
	const [invalidDestination, setInvalidDestination] = useState<DestinationValue>(initialInvalid);
	const [localErrors, setLocalErrors] = useState<Readonly<Record<string, string>>>({});

	const form = useForm({
		defaultValues: defaultsFor(menu),
		validators: { onSubmit: ivrMenuFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = ivrMenuFormSchema.parse(value);
			server.clear();

			const problems: Record<string, string> = {};
			const timeoutProblem = validateDestinationValue(timeoutDestination, { required: false });
			if (timeoutProblem) {
				problems[`timeoutDestination${capitalize(timeoutProblem.field)}`] = timeoutProblem.message;
			}
			const invalidProblem = validateDestinationValue(invalidDestination, { required: false });
			if (invalidProblem) {
				problems[`invalidDestination${capitalize(invalidProblem.field)}`] = invalidProblem.message;
			}
			if (Object.keys(problems).length > 0) {
				setLocalErrors(problems);
				return;
			}
			setLocalErrors({});

			const body = {
				name: parsed.name,
				extensionNumber: parsed.extensionNumber,
				digitTimeoutMs: parsed.digitTimeoutMs ?? undefined,
				interDigitTimeoutMs: parsed.interDigitTimeoutMs ?? undefined,
				maxDigits: parsed.maxDigits ?? undefined,
				maxFailures: parsed.maxFailures ?? undefined,
				maxTimeouts: parsed.maxTimeouts ?? undefined,
				/**
				 * `null` where the numbers above send `undefined`, and the difference is the column's:
				 * the timing knobs are `.optional()` with a server default, so a blank one is left
				 * alone, while the four prompt columns are `.nullish()` and a cleared selector has to
				 * reach the database as `null` or the menu keeps playing a recording the operator just
				 * removed from it.
				 */
				greetingPromptId: parsed.greetingPromptId,
				shortGreetingPromptId: parsed.shortGreetingPromptId,
				invalidPromptId: parsed.invalidPromptId,
				timeoutPromptId: parsed.timeoutPromptId,
				directDialEnabled: parsed.directDialEnabled,
				enabled: parsed.enabled,
				...writeDestination(timeoutDestination, "timeout"),
				...writeDestination(invalidDestination, "invalid"),
			};

			try {
				if (menu === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: menu.id, values: body });
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
					setInvalidDestination(initialInvalid);
					form.reset();
				}
				onOpenChange(next);
			}}
			title={menu === null ? "New IVR menu" : `Edit ${menu.name}`}
			description="What a caller hears, how long they have to answer, and where they go when they do not."
			submitLabel={menu === null ? "Create menu" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			size="lg"
			footerNote={
				menu === null
					? "Digit options are added on the menu's page once it exists — a menu with no options answers and then falls through to its timeout."
					: undefined
			}
		>
			<FormSection title="Menu">
				<form.Field name="name">
					{(field) => (
						<TextField
							field={field}
							label="Name"
							required
							autoFocus={menu === null}
							placeholder="Main menu"
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
							placeholder="8000"
							description="Optional. Lets staff dial the menu directly."
							disabled={mutation.isPending}
							submitError={errors.extensionNumber}
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection
				title="What the caller hears"
				description="Every one of these is optional. A menu with none of them answers in silence and waits for a digit, which is occasionally deliberate and usually not."
			>
				<form.Field name="greetingPromptId">
					{(field) => (
						<PromptSelect
							id="ivrGreetingPromptId"
							label="Greeting"
							value={field.state.value}
							onChange={(next) => field.handleChange(next)}
							emptyLabel="Say nothing"
							description="Played once when the call arrives. Usually the recording that lists the options."
							disabled={mutation.isPending}
							error={errors.greetingPromptId}
						/>
					)}
				</form.Field>
				<form.Field name="shortGreetingPromptId">
					{(field) => (
						<PromptSelect
							id="ivrShortGreetingPromptId"
							label="Short greeting"
							value={field.state.value}
							onChange={(next) => field.handleChange(next)}
							emptyLabel="Repeat the greeting"
							description="Played on every re-prompt after the first, so a caller who mis-keys does not sit through the whole menu again."
							disabled={mutation.isPending}
							error={errors.shortGreetingPromptId}
						/>
					)}
				</form.Field>
				<form.Field name="invalidPromptId">
					{(field) => (
						<PromptSelect
							id="ivrInvalidPromptId"
							label="Wrong key"
							value={field.state.value}
							onChange={(next) => field.handleChange(next)}
							emptyLabel="Say nothing and re-prompt"
							description="Played when the caller presses something the menu has no option for."
							disabled={mutation.isPending}
							error={errors.invalidPromptId}
						/>
					)}
				</form.Field>
				<form.Field name="timeoutPromptId">
					{(field) => (
						<PromptSelect
							id="ivrTimeoutPromptId"
							label="No key at all"
							value={field.state.value}
							onChange={(next) => field.handleChange(next)}
							emptyLabel="Say nothing and re-prompt"
							description="Played when the caller stays silent past the wait below."
							disabled={mutation.isPending}
							error={errors.timeoutPromptId}
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="Timing">
				<form.Field name="digitTimeoutMs">
					{(field) => (
						<TextField
							field={field}
							label="Wait for first digit (ms)"
							placeholder="5000"
							disabled={mutation.isPending}
							submitError={errors.digitTimeoutMs}
						/>
					)}
				</form.Field>
				<form.Field name="interDigitTimeoutMs">
					{(field) => (
						<TextField
							field={field}
							label="Wait between digits (ms)"
							placeholder="2000"
							disabled={mutation.isPending}
							submitError={errors.interDigitTimeoutMs}
						/>
					)}
				</form.Field>
				<form.Field name="maxDigits">
					{(field) => (
						<TextField
							field={field}
							label="Max digits"
							placeholder="1"
							disabled={mutation.isPending}
							submitError={errors.maxDigits}
						/>
					)}
				</form.Field>
				<form.Field name="maxFailures">
					{(field) => (
						<TextField
							field={field}
							label="Wrong entries allowed"
							placeholder="3"
							disabled={mutation.isPending}
							submitError={errors.maxFailures}
						/>
					)}
				</form.Field>
				<form.Field name="maxTimeouts">
					{(field) => (
						<TextField
							field={field}
							label="Silences allowed"
							placeholder="3"
							disabled={mutation.isPending}
							submitError={errors.maxTimeouts}
						/>
					)}
				</form.Field>
			</FormSection>

			<DestinationPicker
				prefix="timeout"
				label="When the caller says nothing"
				description="Taken after the silences allowed above are used up."
				value={timeoutDestination}
				onChange={(next) => {
					setTimeoutDestination(next);
					setLocalErrors({});
				}}
				disabled={mutation.isPending}
				errors={errors}
			/>

			<DestinationPicker
				prefix="invalid"
				label="When the caller presses something else"
				description="Taken after the wrong entries allowed above are used up."
				value={invalidDestination}
				onChange={(next) => {
					setInvalidDestination(next);
					setLocalErrors({});
				}}
				disabled={mutation.isPending}
				errors={errors}
			/>

			<FormSection title="Behaviour" columns={1}>
				<form.Field name="directDialEnabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Allow dialling an extension"
							description="A caller may enter any extension number, not only the options you listed."
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
