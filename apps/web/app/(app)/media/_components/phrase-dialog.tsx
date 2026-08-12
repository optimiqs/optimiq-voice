"use client";

import { useForm } from "@tanstack/react-form";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { phraseFormSchema, type PhraseFormValues } from "~/lib/pbx/schemas";
import { usePbxCreate, usePbxUpdate } from "../../_hooks/use-pbx-queries";
import type { PhraseRow } from "~/lib/pbx/contracts";

/**
 * Create or rename a phrase.
 *
 * ## One field, and the absences are the server's
 *
 * `createPhraseDto` is `{ name }` and nothing else, which is unusual enough to be worth stating
 * rather than leaving to look unfinished:
 *
 * - `kind` and `objectKey` are not fields, they are what MAKES the row a phrase. The service stamps
 *   `kind: "phrase"` and leaves the object key null — the exact pair the table's check constraint
 *   permits — and a client that could send either could produce a library entry with no file behind
 *   it, which every player would then have to guard against.
 * - `language` is absent because a phrase's language is whatever its steps' audio is. A tag on the
 *   sequence that disagreed with the recordings would be a tag that lies.
 * - There is no file input anywhere near this dialog. A phrase owns no audio, so it is created by an
 *   ordinary JSON `POST` rather than through the multipart upload every other row in this table is
 *   born through.
 *
 * The SEQUENCE is not here either. Steps are an ordered child collection with a reorder endpoint,
 * which a dialog inside a dialog cannot hold — so a new phrase is created empty and the footer says
 * where to go, exactly as a new time condition is created with no rules.
 */
export function PhraseDialog({
	open,
	onOpenChange,
	phrase,
}: {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly phrase: PhraseRow | null;
}) {
	const create = usePbxCreate(PBX_RESOURCES.phrases);
	const update = usePbxUpdate(PBX_RESOURCES.phrases);
	const mutation = phrase === null ? create : update;
	const server = useServerFieldErrors();

	const form = useForm({
		defaultValues: { name: phrase?.name ?? "" } satisfies PhraseFormValues,
		validators: { onSubmit: phraseFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = phraseFormSchema.parse(value);
			server.clear();

			try {
				if (phrase === null) {
					await create.mutateAsync({ name: parsed.name });
				} else {
					await update.mutateAsync({ id: phrase.id, values: { name: parsed.name } });
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
			title={phrase === null ? "New phrase" : `Edit ${phrase.name}`}
			description="A named sequence of recordings, played as one announcement wherever a single prompt can be chosen."
			submitLabel={phrase === null ? "Create phrase" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			footerNote={
				phrase === null
					? "The steps — which recordings play, and in what order — are added on the phrase's own page once it exists. A phrase with no steps saves and compiles, and plays nothing."
					: undefined
			}
		>
			<FormSection title="Phrase" columns={1}>
				<form.Field name="name">
					{(field) => (
						<TextField
							field={field}
							label="Name"
							required
							autoFocus
							placeholder="Queue position announcement"
							description="Only this application reads it — the name is not spoken. Name it after what the sequence says, so the picker on an IVR or a queue is choosable without opening it."
							disabled={mutation.isPending}
							submitError={server.errors.name}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
