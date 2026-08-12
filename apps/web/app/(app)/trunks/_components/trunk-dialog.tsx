"use client";

import { useForm } from "@tanstack/react-form";
import { AttachedReference } from "~/components/pbx/attached-reference";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { SelectField, SwitchField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { SIP_TRANSPORTS, TRUNK_KINDS } from "~/lib/pbx/contracts";
import { trunkFormSchema, type TrunkFormValues } from "~/lib/pbx/schemas";
import { usePbxCreate, usePbxUpdate } from "../../_hooks/use-pbx-queries";
import type { TrunkRow } from "~/lib/pbx/contracts";

/**
 * Create and edit a carrier trunk.
 *
 * `status` is deliberately absent from this form. It is the ENGINE's view of the carrier — what
 * the registration actually did — and a control-plane form that could set it would let an admin
 * declare a dead trunk healthy. The list shows it; nothing here writes it.
 *
 * ## `sipSecretRef` is write-only
 *
 * The server strips it from every response (`secretColumns` on `TRUNK_RESOURCE`), so the field
 * cannot be pre-filled and opens blank on an edit. Blank therefore means "leave the stored
 * reference alone" and the key is OMITTED from the PATCH — sending the `null` that a blank
 * optional field would otherwise produce would silently erase the trunk's credential and take the
 * carrier registration down with it. The consequence is that this form can no longer clear a
 * reference; changing one means typing the new one.
 *
 * `authUser` is the public half and still round-trips normally.
 */
const TRUNK_KIND_LABELS: Readonly<Record<(typeof TRUNK_KINDS)[number], string>> = {
	register: "Register with the carrier",
	"ip-auth": "IP authentication",
};

function defaultsFor(trunk: TrunkRow | null): TrunkFormValues {
	return {
		name: trunk?.name ?? "",
		kind: trunk?.kind ?? "register",
		sipDomain: trunk?.sipDomain ?? "",
		sipProxy: trunk?.sipProxy ?? "",
		outboundProxy: trunk?.outboundProxy ?? "",
		authUser: trunk?.authUser ?? "",
		// Never pre-filled: the server does not return it. See the note at the top of this file.
		sipSecretRef: "",
		transport: trunk?.transport ?? "udp",
		registerExpiresSeconds:
			trunk?.registerExpiresSeconds === undefined ? "" : String(trunk.registerExpiresSeconds),
		maxChannels: trunk?.maxChannels == null ? "" : String(trunk.maxChannels),
		codecPrefs: trunk?.codecPrefs ?? "",
		callerIdNumberOverride: trunk?.callerIdNumberOverride ?? "",
		enabled: trunk?.enabled ?? true,
	};
}

export function TrunkDialog({
	open,
	onOpenChange,
	trunk,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	trunk: TrunkRow | null;
}) {
	const create = usePbxCreate(PBX_RESOURCES.trunks);
	const update = usePbxUpdate(PBX_RESOURCES.trunks);
	const mutation = trunk === null ? create : update;
	const server = useServerFieldErrors();

	const form = useForm({
		defaultValues: defaultsFor(trunk),
		validators: { onSubmit: trunkFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = trunkFormSchema.parse(value);
			server.clear();

			const body = {
				name: parsed.name,
				kind: parsed.kind,
				sipDomain: parsed.sipDomain,
				sipProxy: parsed.sipProxy,
				outboundProxy: parsed.outboundProxy,
				authUser: parsed.authUser,
				// Absent when blank — never `null`, which the server would read as "erase it".
				...(parsed.sipSecretRef === null ? {} : { sipSecretRef: parsed.sipSecretRef }),
				transport: parsed.transport,
				// `.optional()` on the server, so a blank field is an ABSENT key, never a null.
				registerExpiresSeconds: parsed.registerExpiresSeconds ?? undefined,
				maxChannels: parsed.maxChannels,
				codecPrefs: parsed.codecPrefs,
				callerIdNumberOverride: parsed.callerIdNumberOverride,
				enabled: parsed.enabled,
			};

			try {
				if (trunk === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: trunk.id, values: body });
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
					server.clear();
					mutation.reset();
					form.reset();
				}
				onOpenChange(next);
			}}
			title={trunk === null ? "New trunk" : `Edit ${trunk.name}`}
			description="How this system reaches a carrier, and how the carrier reaches it."
			submitLabel={trunk === null ? "Create trunk" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			size="lg"
		>
			<FormSection title="Carrier">
				<form.Field name="name">
					{(field) => (
						<TextField
							field={field}
							label="Name"
							required
							autoFocus={trunk === null}
							placeholder="Primary carrier"
							disabled={mutation.isPending}
							submitError={server.errors.name}
						/>
					)}
				</form.Field>
				<form.Field name="kind">
					{(field) => (
						<SelectField
							field={field}
							label="Authentication"
							disabled={mutation.isPending}
							submitError={server.errors.kind}
						>
							{TRUNK_KINDS.map((value) => (
								<option key={value} value={value}>
									{TRUNK_KIND_LABELS[value]}
								</option>
							))}
						</SelectField>
					)}
				</form.Field>
				<form.Field name="sipDomain">
					{(field) => (
						<TextField
							field={field}
							label="SIP domain"
							required
							placeholder="sip.carrier.example"
							disabled={mutation.isPending}
							submitError={server.errors.sipDomain}
						/>
					)}
				</form.Field>
				<form.Field name="sipProxy">
					{(field) => (
						<TextField
							field={field}
							label="SIP proxy"
							required
							placeholder="proxy.carrier.example:5060"
							disabled={mutation.isPending}
							submitError={server.errors.sipProxy}
						/>
					)}
				</form.Field>
				<form.Field name="outboundProxy">
					{(field) => (
						<TextField
							field={field}
							label="Outbound proxy"
							placeholder="Optional"
							disabled={mutation.isPending}
							submitError={server.errors.outboundProxy}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="Credentials">
				<form.Field name="authUser">
					{(field) => (
						<TextField
							field={field}
							label="Auth user"
							disabled={mutation.isPending}
							submitError={server.errors.authUser}
						/>
					)}
				</form.Field>
				<form.Field name="sipSecretRef">
					{(field) => (
						<TextField
							field={field}
							label="SIP secret reference"
							placeholder="secret://trunks/primary"
							description={
								trunk === null
									? "A handle into the secret manager. The password itself is never stored here."
									: "Write-only: the stored reference is never sent back. Leave blank to keep it."
							}
							disabled={mutation.isPending}
							submitError={server.errors.sipSecretRef}
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="Transport and capacity">
				<form.Field name="transport">
					{(field) => (
						<SelectField
							field={field}
							label="Transport"
							disabled={mutation.isPending}
							submitError={server.errors.transport}
						>
							{SIP_TRANSPORTS.map((value) => (
								<option key={value} value={value}>
									{value.toUpperCase()}
								</option>
							))}
						</SelectField>
					)}
				</form.Field>
				<form.Field name="registerExpiresSeconds">
					{(field) => (
						<TextField
							field={field}
							label="Registration expiry (seconds)"
							placeholder="3600"
							disabled={mutation.isPending}
							submitError={server.errors.registerExpiresSeconds}
						/>
					)}
				</form.Field>
				<form.Field name="maxChannels">
					{(field) => (
						<TextField
							field={field}
							label="Max simultaneous calls"
							placeholder="Blank for no limit"
							description="What the carrier will actually carry. Exceeding it is a busy signal, not an error."
							disabled={mutation.isPending}
							submitError={server.errors.maxChannels}
						/>
					)}
				</form.Field>
				<form.Field name="codecPrefs">
					{(field) => (
						<TextField
							field={field}
							label="Codec preference"
							placeholder="PCMU,PCMA,OPUS"
							disabled={mutation.isPending}
							submitError={server.errors.codecPrefs}
						/>
					)}
				</form.Field>
				<form.Field name="callerIdNumberOverride">
					{(field) => (
						<TextField
							field={field}
							label="Caller ID override"
							placeholder="+12125550100"
							description="Forces every call over this trunk to present this number."
							disabled={mutation.isPending}
							submitError={server.errors.callerIdNumberOverride}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="Arriving calls" columns={1}>
				{/*
				 * The clearest case for the shared translation layer, which is why it is worth naming even
				 * while it is read-only: one carrier presents `0044…` and the next presents `+44…`, and
				 * without a rewrite the screening list, the inbound routes and the call records all have to
				 * know which trunk a call came in on. Nothing composes with this — a trunk has no inline
				 * digit manipulation — so it runs first and alone, before anything reads the caller.
				 */}
				<AttachedReference
					label="Rewrite the caller's number on arrival"
					resource={PBX_RESOURCES.translationRulesets}
					value={trunk?.inboundTranslationRulesetId ?? null}
					emptyLabel="No rewrite — the caller's number reaches routing exactly as the carrier presented it."
					description="Applied before the screening list, the inbound routes or the call record read the number, and before anything else on this trunk."
					note="Attaching a ruleset is not editable from this application yet: the column exists and the compiler reads it, but no endpoint accepts it in a request body."
				/>
			</FormSection>

			<FormSection title="State" columns={1}>
				<form.Field name="enabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Enabled"
							description="A disabled trunk is skipped by every outbound route that lists it."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
