"use client";

import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { DestinationPicker } from "~/components/pbx/destination-picker";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { PromptSelect } from "~/components/pbx/resource-select";
import { SelectField, SwitchField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { DIRECTORY_SEARCH_FIELDS } from "~/lib/pbx/contracts";
import {
	EMPTY_DESTINATION,
	readDestination,
	validateDestinationValue,
	writeDestination,
	type DestinationValue,
} from "~/lib/pbx/destinations";
import {
	dialByNameDirectoryFormSchema,
	type DialByNameDirectoryFormValues,
} from "~/lib/pbx/schemas";
import { usePbxCreate, usePbxUpdate } from "../../_hooks/use-pbx-queries";
import type { DialByNameDirectoryRow, DirectorySearchField } from "~/lib/pbx/contracts";

/**
 * A dial-by-name directory.
 *
 * ## There is no member list, and that is the design
 *
 * The entries are DERIVED from the organization's extensions at compile time, so there is nothing
 * here to add somebody to. What decides whether a person is in the directory is whether their
 * mailbox has a recorded NAME greeting: this platform has no text-to-speech, so an entry whose name
 * cannot be SPOKEN cannot be offered — "for … press one" with a silence in the middle is worse than
 * not offering them. Extensions without one are dropped with a compile warning, which arrives in the
 * save's own warnings panel like every other diagnostic.
 *
 * ## The engine has no runtime for this yet
 *
 * The compiler builds the whole keypad index, including the one diagnostic that has no runtime
 * symptom (two people whose names collide on the keypad). The plan walker has no case for the node,
 * so a call that reaches a directory today hears the unavailable announcement. The footer says so.
 */
const SEARCH_FIELD_LABELS: Readonly<Record<DirectorySearchField, string>> = {
	"last-name": "Surname",
	"first-name": "First name",
	"full-name": "Full name",
};

function defaultsFor(directory: DialByNameDirectoryRow | null): DialByNameDirectoryFormValues {
	return {
		name: directory?.name ?? "",
		extensionNumber: directory?.extensionNumber ?? "",
		searchField: directory?.searchField ?? "last-name",
		minDigits: directory?.minDigits === undefined ? "" : String(directory.minDigits),
		greetingPromptId: directory?.greetingPromptId ?? "",
		invalidPromptId: directory?.invalidPromptId ?? "",
		maxFailures: directory?.maxFailures === undefined ? "" : String(directory.maxFailures),
		enabled: directory?.enabled ?? true,
	};
}

export function DirectoryDialog({
	open,
	onOpenChange,
	directory,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	directory: DialByNameDirectoryRow | null;
}) {
	const create = usePbxCreate(PBX_RESOURCES.directories);
	const update = usePbxUpdate(PBX_RESOURCES.directories);
	const mutation = directory === null ? create : update;
	const server = useServerFieldErrors();

	const initial = directory
		? readDestination(directory as unknown as Record<string, unknown>, "timeout")
		: EMPTY_DESTINATION;
	const [timeout, setTimeout] = useState<DestinationValue>(initial);
	const [localErrors, setLocalErrors] = useState<Readonly<Record<string, string>>>({});

	const form = useForm({
		defaultValues: defaultsFor(directory),
		validators: { onSubmit: dialByNameDirectoryFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = dialByNameDirectoryFormSchema.parse(value);
			server.clear();

			const problem = validateDestinationValue(timeout, { required: false });
			if (problem) {
				setLocalErrors({
					[`timeoutDestination${problem.field.charAt(0).toUpperCase()}${problem.field.slice(1)}`]:
						problem.message,
				});
				return;
			}
			setLocalErrors({});

			const body = { ...parsed, ...writeDestination(timeout, "timeout") };
			try {
				if (directory === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: directory.id, values: body });
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
					setTimeout(initial);
					form.reset();
				}
				onOpenChange(next);
			}}
			title={directory === null ? "New directory" : `Edit ${directory.name}`}
			description="Callers spell a name on the keypad and are connected. Who is in it is worked out from your extensions — there is no list to maintain here."
			submitLabel={directory === null ? "Create directory" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			size="lg"
			footerNote="Only extensions whose mailbox has a recorded name greeting appear: there is no text-to-speech, so a name that cannot be spoken cannot be offered. Extensions without one are skipped and named in the warnings when you save. The engine has no directory runtime yet, so a call that reaches this today hears the unavailable announcement."
		>
			<FormSection title="Directory">
				<form.Field name="name">
					{(field) => (
						<TextField
							field={field}
							label="Name"
							required
							autoFocus={directory === null}
							placeholder="Company directory"
							disabled={mutation.isPending}
							submitError={errors.name}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
				<form.Field name="extensionNumber">
					{(field) => (
						<TextField
							field={field}
							label="Internal number"
							placeholder="411"
							description="Optional. A directory reached only from an IVR option needs none."
							disabled={mutation.isPending}
							submitError={errors.extensionNumber}
						/>
					)}
				</form.Field>
				<form.Field name="searchField">
					{(field) => (
						<SelectField field={field} label="Callers spell" submitError={errors.searchField}>
							{DIRECTORY_SEARCH_FIELDS.map((value) => (
								<option key={value} value={value}>
									{SEARCH_FIELD_LABELS[value]}
								</option>
							))}
						</SelectField>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="Matching">
				<form.Field name="minDigits">
					{(field) => (
						<TextField
							field={field}
							label="Digits before matching"
							placeholder="3"
							description="Two is enough for a short surname; past six the caller is spelling the whole name, which is the interaction a directory exists to avoid."
							disabled={mutation.isPending}
							submitError={errors.minDigits}
						/>
					)}
				</form.Field>
				<form.Field name="maxFailures">
					{(field) => (
						<TextField
							field={field}
							label="Attempts allowed"
							placeholder="3"
							description="After this many failed searches the caller takes the branch below."
							disabled={mutation.isPending}
							submitError={errors.maxFailures}
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="What the caller hears">
				<form.Field name="greetingPromptId">
					{(field) => (
						<PromptSelect
							id="directoryGreetingPromptId"
							label="Greeting"
							value={field.state.value}
							onChange={(next) => field.handleChange(next)}
							emptyLabel="The deployment default"
							description="Played on arrival — “spell the first few letters of the surname”."
							disabled={mutation.isPending}
							error={errors.greetingPromptId}
						/>
					)}
				</form.Field>
				<form.Field name="invalidPromptId">
					{(field) => (
						<PromptSelect
							id="directoryInvalidPromptId"
							label="No match"
							value={field.state.value}
							onChange={(next) => field.handleChange(next)}
							emptyLabel="The deployment default"
							description="Played when nothing matched, before the caller is asked again."
							disabled={mutation.isPending}
							error={errors.invalidPromptId}
						/>
					)}
				</form.Field>
			</FormSection>

			<DestinationPicker
				prefix="timeout"
				label="When the caller gives up"
				description="Taken when they time out or run out of attempts. Usually a receptionist or a ring group. Leave it empty to release the call, which is rarely what anyone means."
				value={timeout}
				onChange={(next) => {
					setTimeout(next);
					setLocalErrors({});
				}}
				disabled={mutation.isPending}
				errors={errors}
			/>

			<FormSection title="State" columns={1}>
				<form.Field name="enabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Enabled"
							description="A disabled directory takes no calls; anything pointing at it must be re-pointed first."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
