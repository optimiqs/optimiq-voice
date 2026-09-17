"use client";

import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { DestinationPicker } from "~/components/pbx/destination-picker";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { SwitchField, TextareaField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import {
	EMPTY_DESTINATION,
	readDestination,
	validateDestinationValue,
	writeDestination,
	type DestinationValue,
} from "~/lib/pbx/destinations";
import { audioStreamFormSchema, type AudioStreamFormValues } from "~/lib/pbx/schemas";
import { usePbxCreate, usePbxUpdate } from "../../_hooks/use-pbx-queries";
import type { AudioStreamRow } from "~/lib/pbx/contracts";

/**
 * A remote audio source a call can be sent to.
 *
 * ## The fallback is required, and it is currently doing all the work
 *
 * Remote-URL playback is the one capability in the routing model whose availability depends on the
 * MEDIA DRIVER rather than on the configuration, so a stream node always carries somewhere to go and
 * the compiler refuses one that does not. Today the engine has no stream runtime at all — the plan
 * walker has cases for every other node kind and none for this one — so a call that reaches a stream
 * hears the deployment's unavailable announcement and is released. The form says exactly that rather
 * than implying the fallback is a rare path.
 *
 * The rows are real and are not wasted: they compile, they appear in call records as the destination
 * the caller reached, and the day the media rung lands they play. What is missing is the playback,
 * and this is the wrong place to be vague about which half exists.
 *
 * ## The URL rule is a security check
 *
 * The set of things a tenant may cause the media server to open is a decision about what the media
 * server will READ. `file:///etc/passwd` is a URL. `http(s)` is enforced at the edge, again by the
 * compiler from the snapshot, and a third time here so the message lands on the field.
 */
function defaultsFor(stream: AudioStreamRow | null): AudioStreamFormValues {
	return {
		name: stream?.name ?? "",
		description: stream?.description ?? "",
		url: stream?.url ?? "",
		answerFirst: stream?.answerFirst ?? true,
		maxSeconds: stream?.maxSeconds === undefined ? "" : String(stream.maxSeconds),
		enabled: stream?.enabled ?? true,
	};
}

export function AudioStreamDialog({
	open,
	onOpenChange,
	stream,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	stream: AudioStreamRow | null;
}) {
	const create = usePbxCreate(PBX_RESOURCES.audioStreams);
	const update = usePbxUpdate(PBX_RESOURCES.audioStreams);
	const mutation = stream === null ? create : update;
	const server = useServerFieldErrors();

	const initial = stream
		? readDestination(stream as unknown as Record<string, unknown>, "fallback")
		: EMPTY_DESTINATION;
	const [fallback, setFallback] = useState<DestinationValue>(initial);
	const [localErrors, setLocalErrors] = useState<Readonly<Record<string, string>>>({});

	const form = useForm({
		defaultValues: defaultsFor(stream),
		validators: { onSubmit: audioStreamFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = audioStreamFormSchema.parse(value);
			server.clear();

			const problem = validateDestinationValue(fallback, { required: true });
			if (problem) {
				setLocalErrors({
					[`fallbackDestination${problem.field.charAt(0).toUpperCase()}${problem.field.slice(1)}`]:
						problem.message,
				});
				return;
			}
			setLocalErrors({});

			const body = { ...parsed, ...writeDestination(fallback, "fallback") };
			try {
				if (stream === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: stream.id, values: body });
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
					setFallback(initial);
					form.reset();
				}
				onOpenChange(next);
			}}
			title={stream === null ? "New audio stream" : `Edit ${stream.name}`}
			description="A remote audio source callers can be sent to — a radio feed, an information line."
			submitLabel={stream === null ? "Create audio stream" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			size="lg"
			footerNote="The engine has no remote-playback runtime yet: a call that reaches this stream today hears the unavailable announcement and is released, and does not take the fallback. Configure both anyway — the row compiles, appears in call records, and starts playing the moment the media work lands."
		>
			<FormSection title="Stream" columns={1}>
				<form.Field name="name">
					{(field) => (
						<TextField
							field={field}
							label="Name"
							required
							autoFocus={stream === null}
							placeholder="Traffic information"
							disabled={mutation.isPending}
							submitError={errors.name}
						/>
					)}
				</form.Field>
				<form.Field name="url">
					{(field) => (
						<TextField
							field={field}
							label="Source URL"
							required
							type="url"
							placeholder="https://stream.example.com/traffic.mp3"
							description="http or https only. This is what the media server will open, so nothing else is accepted — the restriction is a boundary on what the server can be made to read, not a formatting rule."
							disabled={mutation.isPending}
							submitError={errors.url}
						/>
					)}
				</form.Field>
				<form.Field name="description">
					{(field) => (
						<TextareaField
							field={field}
							label="Description"
							rows={2}
							placeholder="Whose feed this is, and who to ask when it stops."
							disabled={mutation.isPending}
							submitError={errors.description}
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="Playback">
				<form.Field name="maxSeconds">
					{(field) => (
						<TextField
							field={field}
							label="Play for (seconds)"
							placeholder="0"
							description="Zero means until the caller hangs up, which is what an always-on feed wants. Anything else ends the stream and takes the fallback."
							disabled={mutation.isPending}
							submitError={errors.maxSeconds}
						/>
					)}
				</form.Field>
				<form.Field name="answerFirst">
					{(field) => (
						<SwitchField
							field={field}
							label="Answer the call first"
							description="On for anything a caller pays to listen to. Off plays before answer, which some carriers cut short."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>

			<DestinationPicker
				prefix="fallback"
				label="When the stream ends or cannot be played"
				description="Required. A remote source is somebody else's uptime, and the driver may not be able to open it at all — so the call always has somewhere to go rather than sitting in silence."
				value={fallback}
				onChange={(next) => {
					setFallback(next);
					setLocalErrors({});
				}}
				required
				disabled={mutation.isPending}
				errors={errors}
			/>

			<FormSection title="State" columns={1}>
				<form.Field name="enabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Enabled"
							description="A disabled stream takes no calls; anything pointing at it must be re-pointed first."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
