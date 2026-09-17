"use client";

import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { PromptSelect } from "~/components/pbx/resource-select";
import { SwitchField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_CHILDREN, PBX_RESOURCES } from "~/lib/pbx/client";
import { phraseStepFormSchema, type PhraseStepFormValues } from "~/lib/pbx/schemas";
import { usePbxChildCreate, usePbxChildUpdate, usePbxList } from "../../_hooks/use-pbx-queries";
import type { PhraseRow, PhraseStepRow } from "~/lib/pbx/contracts";

/**
 * One step of a phrase: which recording plays, and where in the sentence.
 *
 * ## A step may not name another phrase, and this form refuses it twice
 *
 * Nesting is refused by the server — `phrases.service.ts` answers a `promptId` naming a
 * `kind = 'phrase'` row with a `PBX_VALIDATION_FAILED` addressed at the field, and the compiler
 * refuses the same shape again for rows that arrive by any other route. Neither refusal is something
 * the DTO or a Zod schema can express: both see a uuid, not the row behind it.
 *
 * So the form does it twice on this side too, and the two halves do different work. The PICKER is
 * `PromptSelect` with the default `kind: "prompt"`, so a phrase is not offered at all — the server
 * filters by kind, which is the only place that filter can be applied correctly. The CHECK below is
 * for the value the picker did not put there: `ReferenceSelectShell` deliberately preserves a stored
 * id its list does not hold rather than rewriting it to the first option, so an existing step whose
 * prompt is outside the first hundred rows keeps its value — and a phrase reached that way would
 * otherwise be sent and come back as a 400 after a round trip.
 *
 * The check reads the phrase list this app has already fetched. It is capped at a page, like every
 * picker here, so it is a courtesy and not a control: the server's refusal is what makes the rule
 * true, and this is what makes the message arrive on the field the user just used.
 *
 * ## `ordinal` is the position, and the list is what usually sets it
 *
 * `(phrase, ordinal)` is unique, so a new step defaults to the next free position rather than to
 * zero. Reordering is done from the list with Move up and Move down, which rewrite the WHOLE order
 * in one request — editing this number by hand collides with whatever already holds the position.
 */
function defaultsFor(step: PhraseStepRow | null, nextOrdinal: number): PhraseStepFormValues {
	return {
		promptId: step?.promptId ?? "",
		ordinal: String(step?.ordinal ?? nextOrdinal),
		enabled: step?.enabled ?? true,
	};
}

export function PhraseStepDialog({
	open,
	onOpenChange,
	phraseId,
	step,
	nextOrdinal,
}: {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly phraseId: string;
	readonly step: PhraseStepRow | null;
	readonly nextOrdinal: number;
}) {
	const child = PBX_CHILDREN.phraseSteps;
	const create = usePbxChildCreate(child, PBX_RESOURCES.phrases.key, phraseId);
	const update = usePbxChildUpdate(child, PBX_RESOURCES.phrases.key, phraseId);
	const mutation = step === null ? create : update;
	const server = useServerFieldErrors();

	/** Only to answer "is this id a phrase?" — see the note at the top of this file. */
	const phrases = usePbxList<PhraseRow>(PBX_RESOURCES.phrases, { page: 1, limit: 100 });
	const phraseIds = new Set(phrases.rows.map((row) => row.id));

	const [localError, setLocalError] = useState<string | undefined>(undefined);

	const form = useForm({
		defaultValues: defaultsFor(step, nextOrdinal),
		validators: { onSubmit: phraseStepFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = phraseStepFormSchema.parse(value);
			server.clear();

			if (phraseIds.has(parsed.promptId)) {
				setLocalError(
					parsed.promptId === phraseId
						? "A phrase cannot play itself."
						: "A step plays a recording, not another phrase. Phrases do not nest — copy the steps you want instead.",
				);
				return;
			}
			setLocalError(undefined);

			const values = {
				promptId: parsed.promptId,
				// `.optional()` on the server with a unique `(phrase, ordinal)` index behind it, so a blank
				// box is an ABSENT key and never a null — and the list's next free position is what the
				// field opens on, so blank is a state the user has to work at reaching.
				ordinal: parsed.ordinal ?? undefined,
				enabled: parsed.enabled,
			};

			try {
				if (step === null) {
					await create.mutateAsync(values);
				} else {
					await update.mutateAsync({ id: step.id, values });
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
					setLocalError(undefined);
					form.reset();
				}
				onOpenChange(next);
			}}
			title={step === null ? "Add step" : "Edit step"}
			description="One recording of the sequence. Every enabled step plays in order, and the order is the sentence."
			submitLabel={step === null ? "Add step" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
		>
			<FormSection title="Audio" columns={1}>
				<form.Field name="promptId">
					{(field) => (
						<PromptSelect
							id="promptId"
							label="Recording"
							value={field.state.value}
							onChange={(next) => {
								field.handleChange(next);
								setLocalError(undefined);
							}}
							allowEmpty={false}
							placeholder="Choose a recording…"
							description="The library only — a phrase is not offered here, because phrases do not nest. Hold-music files and mailbox greetings are not offered either: they are reached through the class or the mailbox that owns them."
							disabled={mutation.isPending}
							error={localError ?? server.errors.promptId}
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="Placement">
				<form.Field name="ordinal">
					{(field) => (
						<TextField
							field={field}
							label="Position"
							description="Lower plays first. Use Move up and Move down on the list instead of editing this — two steps cannot share a position, and the list rewrites the whole order in one request."
							disabled={mutation.isPending}
							submitError={server.errors.ordinal}
						/>
					)}
				</form.Field>
				<form.Field name="enabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Enabled"
							description="A disabled step is skipped and keeps its place in the order — which is how half a sentence is prepared without changing what callers hear today."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
