"use client";

import { useForm } from "@tanstack/react-form";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { ResourceSelect } from "~/components/pbx/resource-select";
import { SelectField, SwitchField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { RECORD_POLICIES } from "~/lib/pbx/contracts";
import { conferenceFormSchema, type ConferenceFormValues } from "~/lib/pbx/schemas";
import { usePbxCreate, usePbxUpdate } from "../../_hooks/use-pbx-queries";
import type { ConferenceRow, RecordPolicy } from "~/lib/pbx/contracts";

/**
 * A conference is one shared floor rather than a leg with a direction, so `inbound`/`outbound`
 * collapse: every policy except `none` and `on-demand` records the whole room from the first
 * joiner. The labels say so instead of letting the vocabulary imply a distinction the mixer
 * cannot make.
 */
const RECORD_POLICY_LABELS: Readonly<Record<RecordPolicy, string>> = {
	none: "Never record",
	inbound: "Record the room",
	outbound: "Record the room (direction means nothing here)",
	all: "Record the room",
	"on-demand": "Only when a moderator starts it",
};

/**
 * A conference room: a number people dial to end up in the same call.
 *
 * ## PINs are not here, and that is not an oversight
 *
 * `pinHash` and `moderatorPinHash` are absent from the API's DTO for the same reason
 * `voicemail_box.pinHash` is: a PIN is set through an endpoint that hashes it, never by an admin
 * pasting a digest into a JSON body. Both endpoints exist now, and both are reached from the row's
 * action menu — see `conference-pin-dialog.tsx`. Nothing here can show whether a room has one,
 * because the server strips the digests from every response.
 *
 * "Wait for a moderator" still carries a note, but it is now a dependency rather than a warning.
 * The moderator PIN is compiled into the artifact and checked by the engine, and matching it is
 * what releases everybody holding — so the switch works, and it works ONLY once the room has a
 * moderator PIN. Nothing here can tell whether it does (the digests never leave the server), so
 * the note says what the pairing needs rather than asserting the room is misconfigured.
 */
function defaultsFor(conference: ConferenceRow | null): ConferenceFormValues {
	return {
		name: conference?.name ?? "",
		roomNumber: conference?.roomNumber ?? "",
		maxMembers: conference?.maxMembers === undefined ? "" : String(conference.maxMembers),
		mohClassId: conference?.mohClassId ?? "",
		recordPolicy: conference?.recordPolicy ?? "none",
		announceJoinLeave: conference?.announceJoinLeave ?? true,
		entryToneEnabled: conference?.entryToneEnabled ?? true,
		exitToneEnabled: conference?.exitToneEnabled ?? true,
		waitForModerator: conference?.waitForModerator ?? false,
		enabled: conference?.enabled ?? true,
	};
}

export function ConferenceDialog({
	open,
	onOpenChange,
	conference,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	conference: ConferenceRow | null;
}) {
	const create = usePbxCreate(PBX_RESOURCES.conferences);
	const update = usePbxUpdate(PBX_RESOURCES.conferences);
	const mutation = conference === null ? create : update;
	const server = useServerFieldErrors();

	const form = useForm({
		defaultValues: defaultsFor(conference),
		validators: { onSubmit: conferenceFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = conferenceFormSchema.parse(value);
			server.clear();

			const body = {
				name: parsed.name,
				roomNumber: parsed.roomNumber,
				maxMembers: parsed.maxMembers,
				mohClassId: parsed.mohClassId,
				recordPolicy: parsed.recordPolicy,
				announceJoinLeave: parsed.announceJoinLeave,
				entryToneEnabled: parsed.entryToneEnabled,
				exitToneEnabled: parsed.exitToneEnabled,
				waitForModerator: parsed.waitForModerator,
				enabled: parsed.enabled,
			};

			try {
				if (conference === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: conference.id, values: body });
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
			title={conference === null ? "New conference room" : `Edit ${conference.name}`}
			description="A number people dial to end up in the same call."
			submitLabel={conference === null ? "Create room" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			footerNote="PINs are set from this room's Actions menu, through an endpoint that hashes them rather than accepting a digest in this form. Nothing can display whether a room has one — the digests never leave the server."
		>
			<FormSection title="Room">
				<form.Field name="name">
					{(field) => (
						<TextField
							field={field}
							label="Name"
							required
							autoFocus={conference === null}
							placeholder="All hands"
							disabled={mutation.isPending}
							submitError={server.errors.name}
						/>
					)}
				</form.Field>
				<form.Field name="roomNumber">
					{(field) => (
						<TextField
							field={field}
							label="Room number"
							required
							placeholder="8000"
							description="What people dial to enter. Unique in this organization."
							disabled={mutation.isPending}
							submitError={server.errors.roomNumber}
						/>
					)}
				</form.Field>
				<form.Field name="maxMembers">
					{(field) => (
						<TextField
							field={field}
							label="Maximum participants"
							placeholder="50"
							description="Leave empty for the server's default."
							disabled={mutation.isPending}
							submitError={server.errors.maxMembers}
						/>
					)}
				</form.Field>
				<form.Field name="mohClassId">
					{(field) => (
						<ResourceSelect
							id="conferenceMohClassId"
							label="Hold music"
							resource={PBX_RESOURCES.mohClasses}
							value={field.state.value}
							onChange={(next) => field.handleChange(next)}
							emptyLabel="The organization default"
							description="What the first person in the room hears while they are alone in it — and what everyone hears for as long as the switch below holds them."
							disabled={mutation.isPending}
							error={server.errors.mohClassId}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="Behaviour" columns={1}>
				<form.Field name="announceJoinLeave">
					{(field) => (
						<SwitchField
							field={field}
							label="Announce arrivals and departures"
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
				<form.Field name="waitForModerator">
					{(field) => (
						<SwitchField
							field={field}
							label="Hold participants until a moderator arrives"
							description="Callers hear music on hold until somebody enters this room's moderator PIN. Set one from the Actions menu — without it nobody can arrive as a moderator and every caller waits until the call is dropped."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
				<form.Field name="entryToneEnabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Play a tone when somebody joins"
							description="A beep, distinct from the name announcement above."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
				<form.Field name="exitToneEnabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Play a tone when somebody leaves"
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
				<form.Field name="recordPolicy">
					{(field) => (
						<SelectField
							field={field}
							label="Recording"
							description="The same vocabulary extensions and queues use — it replaced this room's on/off switch."
							disabled={mutation.isPending}
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
					{(field) => (
						<SwitchField
							field={field}
							label="Enabled"
							description="A disabled room refuses callers; anything that routes calls to it stops working."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
