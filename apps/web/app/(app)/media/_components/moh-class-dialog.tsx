"use client";

import { useForm } from "@tanstack/react-form";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { Field, FieldDescription, FieldLabel, Select } from "~/components/ui/field";
import { SelectField, SwitchField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { MOH_SOURCES } from "~/lib/pbx/contracts";
import { mohClassFormSchema, type MohClassFormValues } from "~/lib/pbx/schemas";
import { usePbxCreate, usePbxUpdate } from "../../_hooks/use-pbx-queries";
import type { MohClassRow, MohSource } from "~/lib/pbx/contracts";

/**
 * A music-on-hold class: a name, and where the audio behind it comes from.
 *
 * ## The two sources are genuinely different things wearing one form
 *
 * A `library` class plays the files uploaded into it, in order or shuffled, and its `streamUri` is
 * meaningless. A `stream` class plays whatever a URI hands it — an Icecast feed, a shoutcast relay
 * — and its files and shuffle setting are meaningless. The schema encodes exactly one rule about
 * that (a `stream` class with no URI is refused, on the URI field, because it would play silence
 * that the media server cannot report), and this form does no more than that.
 *
 * Specifically, the URI field is rendered for BOTH sources rather than hidden for `library`, and
 * the shuffle switch likewise. Hiding a control that holds a value is how a value gets silently
 * carried through an edit nobody can see; a hint that says which source reads it costs one line and
 * leaves the stored row visible. The same reasoning as every other conditional field in this area.
 *
 * ## Sample rate is a fixed list, not a number box
 *
 * 8 kHz, 16 kHz and 48 kHz are what the schema accepts, because they are what a media server
 * resamples between without artefacts — and because a free-text field invites 44100, which is the
 * one number everybody reaches for and the one that costs a resample on every hold. The schema
 * types them as number literals rather than strings, so this is a raw `<Select>` with a cast at the
 * boundary rather than `SelectField`, whose whole contract is string values.
 *
 * ## `isDefault` is a radio group in disguise
 *
 * At most one class in an organization holds it, and the server is what enforces that: setting it
 * here clears it wherever it was. That is why the description says what will happen to the current
 * default rather than pretending this is an independent switch.
 */
const SAMPLE_RATES = [8000, 16_000, 48_000] as const;
type SampleRate = (typeof SAMPLE_RATES)[number];

const SOURCE_LABELS: Readonly<Record<MohSource, string>> = {
	library: "Library — the files uploaded into this class",
	stream: "Stream — audio pulled from a URI",
};

function defaultsFor(mohClass: MohClassRow | null): MohClassFormValues {
	return {
		name: mohClass?.name ?? "",
		description: mohClass?.description ?? "",
		source: mohClass?.source ?? "library",
		streamUri: mohClass?.streamUri ?? "",
		shuffle: mohClass?.shuffle ?? false,
		sampleRateHz: (mohClass?.sampleRateHz as SampleRate | undefined) ?? 8000,
		isDefault: mohClass?.isDefault ?? false,
		enabled: mohClass?.enabled ?? true,
	};
}

export function MohClassDialog({
	open,
	onOpenChange,
	mohClass,
}: {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly mohClass: MohClassRow | null;
}) {
	const create = usePbxCreate(PBX_RESOURCES.mohClasses);
	const update = usePbxUpdate(PBX_RESOURCES.mohClasses);
	const mutation = mohClass === null ? create : update;
	const server = useServerFieldErrors();

	const form = useForm({
		defaultValues: defaultsFor(mohClass),
		validators: { onSubmit: mohClassFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = mohClassFormSchema.parse(value);
			server.clear();

			const body = {
				name: parsed.name,
				description: parsed.description,
				source: parsed.source,
				streamUri: parsed.streamUri,
				shuffle: parsed.shuffle,
				sampleRateHz: parsed.sampleRateHz,
				isDefault: parsed.isDefault,
				enabled: parsed.enabled,
			};

			try {
				if (mohClass === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: mohClass.id, values: body });
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
			title={mohClass === null ? "New hold music class" : `Edit ${mohClass.name}`}
			description="What a caller hears while they are waiting — on hold, in a queue, or parked."
			submitLabel={mohClass === null ? "Create class" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			footerNote="The name is what reaches the media server — five kinds of routing node carry it rather than the id — so renaming a class republishes the dial plan."
		>
			<FormSection title="Class">
				<form.Field name="name">
					{(field) => (
						<TextField
							field={field}
							label="Name"
							required
							autoFocus={mohClass === null}
							placeholder="default"
							description="Letters, digits, dot, dash and underscore. This becomes a section name in the media server."
							disabled={mutation.isPending}
							submitError={server.errors.name}
						/>
					)}
				</form.Field>
				<form.Field name="description">
					{(field) => (
						<TextField
							field={field}
							label="Description"
							placeholder="Licensed instrumental loop"
							disabled={mutation.isPending}
							submitError={server.errors.description}
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="Audio">
				<form.Field name="source">
					{(field) => (
						<SelectField
							field={field}
							label="Source"
							description="Where the audio comes from. Files are uploaded from this class's row on the list."
							disabled={mutation.isPending}
							submitError={server.errors.source}
						>
							{MOH_SOURCES.map((value) => (
								<option key={value} value={value}>
									{SOURCE_LABELS[value]}
								</option>
							))}
						</SelectField>
					)}
				</form.Field>

				<form.Field name="sampleRateHz">
					{(field) => (
						<Field name={field.name}>
							<FieldLabel htmlFor={field.name}>Sample rate</FieldLabel>
							<Select
								id={field.name}
								value={String(field.state.value)}
								onChange={(event) =>
									field.handleChange(Number(event.target.value) as SampleRate)
								}
								onBlur={field.handleBlur}
								disabled={mutation.isPending}
								aria-invalid={server.errors.sampleRateHz ? true : undefined}
							>
								{SAMPLE_RATES.map((rate) => (
									<option key={rate} value={rate}>
										{rate.toLocaleString()} Hz
									</option>
								))}
							</Select>
							<FieldDescription>
								8 kHz matches the narrowband codecs most calls use. Choose higher only when the
								audio is played to wideband endpoints — anything else is resampled on every hold.
							</FieldDescription>
							{server.errors.sampleRateHz ? (
								<p role="alert" className="text-xs text-danger">
									{server.errors.sampleRateHz}
								</p>
							) : null}
						</Field>
					)}
				</form.Field>

				<form.Subscribe selector={(state) => state.values.source}>
					{(source) => (
						<form.Field name="streamUri">
							{(field) => (
								<TextField
									field={field}
									label="Stream URI"
									required={source === "stream"}
									placeholder="https://stream.example.com/hold.mp3"
									description={
										source === "stream"
											? "The media server pulls this while anybody is on hold. Required for a streaming class."
											: "Only read by a streaming class. A library class plays its uploaded files and ignores this."
									}
									disabled={mutation.isPending}
									submitError={server.errors.streamUri}
									className="sm:col-span-2"
								/>
							)}
						</form.Field>
					)}
				</form.Subscribe>
			</FormSection>

			<FormSection title="Behaviour" columns={1}>
				<form.Field name="shuffle">
					{(field) => (
						<SwitchField
							field={field}
							label="Shuffle the files"
							description="Plays this class's uploads in a random order rather than the order they were added. A streaming class ignores it."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
				<form.Field name="isDefault">
					{(field) => (
						<SwitchField
							field={field}
							label="Use this class when nothing names another"
							description="One class per organization holds this. Switching it on here takes it away from whichever class holds it now."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
				<form.Field name="enabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Enabled"
							description="A disabled class is not offered anywhere, and anything already pointing at it falls back to the server's own hold music."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
