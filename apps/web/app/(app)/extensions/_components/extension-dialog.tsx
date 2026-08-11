"use client";

import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { ResourceSelect } from "~/components/pbx/resource-select";
import { SelectField, SwitchField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { RECORD_POLICIES, TOLL_CLASSES } from "~/lib/pbx/contracts";
import {
	followMeFieldErrors,
	normalizeFollowMe,
	readFollowMe,
	sameFollowMe,
	writeFollowMe,
} from "~/lib/pbx/follow-me";
import {
	extensionEditFormSchema,
	extensionFormSchema,
	followMeFormSchema,
	type ExtensionFormValues,
	type FollowMeFormValues,
} from "~/lib/pbx/schemas";
import { usePbxCreate, usePbxUpdate } from "../../_hooks/use-pbx-queries";
import { FollowMeField } from "./follow-me-field";
import type { ExtensionRow } from "~/lib/pbx/contracts";

/**
 * Create and edit an extension.
 *
 * ## The SIP secret is a reference, not a password — and it is write-only
 *
 * `sipSecretRef` is a handle into the secret manager — the password itself never reaches this
 * database, which is why the field is a plain text input labelled as a reference rather than a
 * masked password box. Rendering it as a password field would tell the user they are typing a
 * credential, and they would.
 *
 * It does not come back. The server strips it, and `sipPasswordHa1` with it, from every response
 * (`secretColumns` on `EXTENSION_RESOURCE`), so there is nothing to pre-fill: on an edit the field
 * opens blank and means "leave the stored reference alone" unless the operator types a new one.
 * That is why editing validates against `extensionEditFormSchema` and why a blank reference is
 * OMITTED from the PATCH rather than sent as `null` — an absent key is the only encoding of "do
 * not touch this" the server accepts.
 *
 * ## Toll class is not a formality
 *
 * An extension may only take an outbound route whose class its own class covers. `national` is
 * the server's default and stays the default here: quietly granting `international` to every new
 * extension is how a compromised endpoint becomes an expensive weekend.
 *
 * ## The follow-me ladder is the one field this form sends only when it changed
 *
 * Every other control here writes a scalar column, so sending it unchanged writes back what was
 * already there. `followMe` is a JSON object that a PATCH REPLACES whole — no merge, because an
 * absent target in an array is a deleted target — which makes an unconditional write a different
 * thing entirely: opening this dialog to correct a caller ID would rewrite the ladder from whatever
 * the editor happened to render.
 *
 * So the key is included only when {@link sameFollowMe} says the ladder differs from the stored
 * one, which is the diff-only rule the routing settings screen established (`changedSettings`)
 * applied to the one field on this form that needs it. Its consequence is worth stating: an
 * extension nobody has ever configured follow-me on gets NO `followMe` key on any save from this
 * dialog, so the column stays `null` rather than becoming an empty ladder.
 */

const TOLL_CLASS_LABELS: Readonly<Record<(typeof TOLL_CLASSES)[number], string>> = {
	internal: "Internal only",
	local: "Local",
	national: "National",
	international: "International",
	premium: "Premium rate",
};

const RECORD_POLICY_LABELS: Readonly<Record<(typeof RECORD_POLICIES)[number], string>> = {
	none: "Never record",
	inbound: "Inbound calls",
	outbound: "Outbound calls",
	all: "All calls",
	"on-demand": "On demand only",
};

function defaultsFor(extension: ExtensionRow | null): ExtensionFormValues {
	return {
		number: extension?.number ?? "",
		label: extension?.label ?? "",
		// Never pre-filled: the server does not return it. See the note at the top of this file.
		sipSecretRef: "",
		callerIdName: extension?.callerIdName ?? "",
		callerIdNumber: extension?.callerIdNumber ?? "",
		outboundCallerIdNumber: extension?.outboundCallerIdNumber ?? "",
		tollClass: extension?.tollClass ?? "national",
		recordPolicy: extension?.recordPolicy ?? "none",
		pickupGroup: extension?.pickupGroup ?? "",
		callTimeoutSeconds:
			extension?.callTimeoutSeconds === undefined ? "" : String(extension.callTimeoutSeconds),
		maxRegistrations:
			extension?.maxRegistrations === undefined ? "" : String(extension.maxRegistrations),
		mohClassId: extension?.mohClassId ?? "",
		voicemailEnabled: extension?.voicemailEnabled ?? true,
		doNotDisturb: extension?.doNotDisturb ?? false,
		enabled: extension?.enabled ?? true,
	};
}

export function ExtensionDialog({
	open,
	onOpenChange,
	extension,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** `null` creates; a row edits it. */
	extension: ExtensionRow | null;
}) {
	const create = usePbxCreate(PBX_RESOURCES.extensions);
	const update = usePbxUpdate(PBX_RESOURCES.extensions);
	const mutation = extension === null ? create : update;
	const server = useServerFieldErrors();

	// Creating requires a secret reference; editing accepts a blank one as "leave it alone".
	const schema = extension === null ? extensionFormSchema : extensionEditFormSchema;

	/**
	 * The ladder lives beside the form, not in it — a nested array of objects is not what TanStack
	 * Form's `defaultValues` is good at, and the trunk chain and destination trios on the other
	 * dialogs are held the same way for the same reason.
	 */
	const initialFollowMe = readFollowMe(extension);
	const [followMe, setFollowMe] = useState<FollowMeFormValues>(initialFollowMe);
	const [localErrors, setLocalErrors] = useState<Readonly<Record<string, string>>>({});

	const form = useForm({
		defaultValues: defaultsFor(extension),
		validators: { onSubmit: schema },
		onSubmit: async ({ value }) => {
			const parsed = schema.parse(value);
			server.clear();

			// Per-rung messages, so a ladder of six with one bad number says which one. The server
			// cannot: `pbxFieldErrors` collapses `followMe.targets.0.destination` to `followMe`.
			const followMeProblems = followMeFieldErrors(followMe);
			if (Object.keys(followMeProblems).length > 0) {
				setLocalErrors(followMeProblems);
				return;
			}
			setLocalErrors({});

			const nextFollowMe = writeFollowMe(followMeFormSchema.parse(followMe));
			const storedFollowMe = normalizeFollowMe(extension?.followMe);

			/**
			 * `undefined` for the optional numbers, never `null`.
			 *
			 * `callTimeoutSeconds` and `maxRegistrations` are `.optional()` on the server, not
			 * `.nullish()` — a null is a 400. `JSON.stringify` drops undefined keys, and an absent key
			 * on a PATCH means "leave it alone", which is exactly what a blank optional field means.
			 *
			 * `mohClassId` is the opposite case and goes on the wire as `null` when it is empty: it is
			 * `.nullish()`, and an absent key would mean an operator who chose "the organization
			 * default" would keep hearing whichever class was set before.
			 */
			const body = {
				number: parsed.number,
				label: parsed.label,
				/**
				 * Present only when there is one to send.
				 *
				 * On a create the schema guarantees a non-empty string. On an edit a blank field
				 * parses to `null`, and `null` is not "unchanged" to the server — `sipSecretRef` is
				 * `z.string().min(1)` on the create DTO, so a null is a 400 and would be a confusing
				 * one. Dropping the key is what leaves the stored reference alone.
				 */
				...(parsed.sipSecretRef === null ? {} : { sipSecretRef: parsed.sipSecretRef }),
				callerIdName: parsed.callerIdName,
				callerIdNumber: parsed.callerIdNumber,
				outboundCallerIdNumber: parsed.outboundCallerIdNumber,
				tollClass: parsed.tollClass,
				recordPolicy: parsed.recordPolicy,
				/**
				 * `null` when blank, never an absent key — the same rule `mohClassId` follows and for
				 * the same reason. The column is `nullish` on the server, so `null` clears it; an
				 * absent key would leave an operator who emptied the field still in their old group,
				 * with nothing on screen disagreeing and `*8` still reaching their old colleagues.
				 */
				pickupGroup: parsed.pickupGroup,
				callTimeoutSeconds: parsed.callTimeoutSeconds ?? undefined,
				maxRegistrations: parsed.maxRegistrations ?? undefined,
				mohClassId: parsed.mohClassId,
				voicemailEnabled: parsed.voicemailEnabled,
				doNotDisturb: parsed.doNotDisturb,
				enabled: parsed.enabled,
				/** Present only when the ladder differs — see the note at the top of this file. */
				...(sameFollowMe(storedFollowMe, nextFollowMe) ? {} : { followMe: nextFollowMe }),
			};

			try {
				if (extension === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: extension.id, values: body });
				}
				form.reset();
				onOpenChange(false);
			} catch (error) {
				server.capture(error);
			}
		},
	});

	return (
		<EntityFormDialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					// Reset on CLOSE, not on open: a dialog that clears itself as it fades out looks
					// finished, whereas clearing on open flashes the previous row's values first.
					server.clear();
					mutation.reset();
					setLocalErrors({});
					setFollowMe(initialFollowMe);
					form.reset();
				}
				onOpenChange(next);
			}}
			title={extension === null ? "New extension" : `Edit ${extension.number}`}
			description="An internal endpoint: what it dials as, what it may dial, and what happens when nobody answers."
			submitLabel={extension === null ? "Create extension" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			size="lg"
		>
			<FormSection title="Identity">
				<form.Field name="number">
					{(field) => (
						<TextField
							field={field}
							label="Extension number"
							required
							autoFocus={extension === null}
							placeholder="1001"
							disabled={mutation.isPending}
							submitError={server.errors.number}
						/>
					)}
				</form.Field>
				<form.Field name="label">
					{(field) => (
						<TextField
							field={field}
							label="Name"
							required
							placeholder="Alice Nguyen"
							disabled={mutation.isPending}
							submitError={server.errors.label}
						/>
					)}
				</form.Field>
				<form.Field name="sipSecretRef">
					{(field) => (
						<TextField
							field={field}
							label="SIP secret reference"
							required={extension === null}
							placeholder="secret://extensions/1001"
							description={
								extension === null
									? "A handle into the secret manager. The password itself is never stored here."
									: "Write-only: the stored reference is never sent back. Leave blank to keep it."
							}
							disabled={mutation.isPending}
							submitError={server.errors.sipSecretRef}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="Caller ID">
				<form.Field name="callerIdName">
					{(field) => (
						<TextField
							field={field}
							label="Internal name"
							placeholder="Alice Nguyen"
							disabled={mutation.isPending}
							submitError={server.errors.callerIdName}
						/>
					)}
				</form.Field>
				<form.Field name="callerIdNumber">
					{(field) => (
						<TextField
							field={field}
							label="Internal number"
							placeholder="1001"
							disabled={mutation.isPending}
							submitError={server.errors.callerIdNumber}
						/>
					)}
				</form.Field>
				<form.Field name="outboundCallerIdNumber">
					{(field) => (
						<TextField
							field={field}
							label="Outbound number"
							placeholder="+12125550100"
							description="What the outside world sees. Blank uses the trunk's own caller ID."
							disabled={mutation.isPending}
							submitError={server.errors.outboundCallerIdNumber}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="Calling and recording">
				<form.Field name="tollClass">
					{(field) => (
						<SelectField
							field={field}
							label="Toll class"
							required
							description="This extension may only take outbound routes at or below this class."
							disabled={mutation.isPending}
							submitError={server.errors.tollClass}
						>
							{TOLL_CLASSES.map((value) => (
								<option key={value} value={value}>
									{TOLL_CLASS_LABELS[value]}
								</option>
							))}
						</SelectField>
					)}
				</form.Field>
				<form.Field name="recordPolicy">
					{(field) => (
						<SelectField
							field={field}
							label="Recording"
							disabled={mutation.isPending}
							submitError={server.errors.recordPolicy}
						>
							{RECORD_POLICIES.map((value) => (
								<option key={value} value={value}>
									{RECORD_POLICY_LABELS[value]}
								</option>
							))}
						</SelectField>
					)}
				</form.Field>
				<form.Field name="callTimeoutSeconds">
					{(field) => (
						<TextField
							field={field}
							label="Ring for (seconds)"
							placeholder="30"
							description="Blank keeps the system default."
							disabled={mutation.isPending}
							submitError={server.errors.callTimeoutSeconds}
						/>
					)}
				</form.Field>
				<form.Field name="maxRegistrations">
					{(field) => (
						<TextField
							field={field}
							label="Max registered devices"
							placeholder="3"
							disabled={mutation.isPending}
							submitError={server.errors.maxRegistrations}
						/>
					)}
				</form.Field>
				<form.Field name="pickupGroup">
					{(field) => (
						<TextField
							field={field}
							label="Pickup group"
							placeholder="sales"
							description="Dialling *8 answers a call ringing on another phone in the same group. Blank leaves this extension ungrouped: anyone may answer its calls, and it may answer only other ungrouped extensions. Until any extension has a group, *8 stays organization-wide."
							disabled={mutation.isPending}
							submitError={server.errors.pickupGroup}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
				<form.Field name="mohClassId">
					{(field) => (
						<ResourceSelect
							id="mohClassId"
							label="Hold music"
							resource={PBX_RESOURCES.mohClasses}
							value={field.state.value}
							onChange={(next) => field.handleChange(next)}
							emptyLabel="The organization default"
							description="What the other party hears when this extension puts them on hold or transfers them."
							disabled={mutation.isPending}
							error={server.errors.mohClassId}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
			</FormSection>

			<FollowMeField
				value={followMe}
				onChange={(next) => {
					setFollowMe(next);
					setLocalErrors({});
				}}
				disabled={mutation.isPending}
				errors={{ ...server.errors, ...localErrors }}
			/>

			<FormSection title="Behaviour" columns={1}>
				<form.Field name="voicemailEnabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Voicemail"
							description="Unanswered calls go to this extension's mailbox."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
				<form.Field name="doNotDisturb">
					{(field) => (
						<SwitchField
							field={field}
							label="Do not disturb"
							description="Calls skip this extension entirely."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
				<form.Field name="enabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Enabled"
							description="A disabled extension cannot register and is skipped by every route."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
