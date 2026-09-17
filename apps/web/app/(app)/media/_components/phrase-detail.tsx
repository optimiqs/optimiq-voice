"use client";

import Link from "next/link";
import { useState } from "react";
import { ChildCollectionCard } from "~/components/pbx/child-collection";
import { DeleteEntityDialog } from "~/components/pbx/delete-entity-dialog";
import { MediaPreviewButton } from "~/components/pbx/media-preview-button";
import { EnabledBadge } from "~/components/pbx/resource-list";
import { RowActions } from "~/components/pbx/row-actions";
import { NoticeBanner } from "~/components/pbx/warnings-banner";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/empty-state";
import { MenuItem } from "~/components/ui/menu";
import { PageHeader } from "~/components/ui/page-header";
import { LoadingPanel } from "~/components/ui/spinner";
import { ApiError } from "~/lib/api-client";
import { PBX_CHILDREN, PBX_RESOURCES } from "~/lib/pbx/client";
import { mediaTabHref } from "~/lib/routes";
import { usePermission } from "../../_context/session-context";
import { usePromptList, usePromptPlaybackUrl } from "../../_hooks/use-media-queries";
import {
	usePbxChildDelete,
	usePbxChildReorder,
	usePbxChildren,
	usePbxItem,
} from "../../_hooks/use-pbx-queries";
import { PhraseDialog } from "./phrase-dialog";
import { PhraseStepDialog } from "./phrase-step-dialog";
import type { PhraseRow, PhraseStepRow, PromptRow } from "~/lib/pbx/contracts";

/**
 * One phrase and the recordings it plays, in order.
 *
 * ## The order is the sentence
 *
 * "Your call is number", "seven", "in the queue" played in another order is not a slower
 * announcement, it is a different one. That is why Move up and Move down send the COMPLETE list of
 * ids to `PUT /phrases/:id/steps/reorder` rather than a sequence of PATCHes: `(phrase, ordinal)` is
 * unique, so most of the intermediate states N patches would pass through are not writable at all,
 * and each one that was would publish another sentence to the routing cache — `phrase_step` is a
 * routing input, so a reorder republishes the dial plan.
 *
 * There is no optimistic swap, for the reason every ordered collection in this app gives: the reply
 * carries the list as the server stored it, and a refused permutation must not leave a rearranged
 * order on screen.
 *
 * ## A phrase with no enabled steps plays nothing, and that is a warning rather than an error
 *
 * It saves, it compiles, and an IVR pointed at it gets silence where an announcement should be.
 * Legitimate — it is how a sequence is built before it is wired up — and also exactly what a
 * half-finished one looks like, so the page says which it is.
 *
 * ## Why the steps name recordings rather than showing a count
 *
 * The step row carries a `promptId` and nothing else, so the names come from one page of the prompt
 * library, cached and shared with every picker on the page. A prompt outside that page renders as a
 * short id rather than as a blank: "there is audio here and this screen cannot name it" is a
 * different fact from "this step has no audio", and only one of them is possible.
 */
export function PhraseDetail({ phraseId }: { phraseId: string }) {
	const phrase = usePbxItem<PhraseRow>(PBX_RESOURCES.phrases, phraseId);
	const steps = usePbxChildren(PBX_CHILDREN.phraseSteps, PBX_RESOURCES.phrases.key, phraseId);
	const removeStep = usePbxChildDelete(
		PBX_CHILDREN.phraseSteps,
		PBX_RESOURCES.phrases.key,
		phraseId,
	);
	const reorder = usePbxChildReorder(PBX_CHILDREN.phraseSteps, PBX_RESOURCES.phrases.key, phraseId);

	/** Steps carry a prompt id; the table has to say a name. Capped at the API's page size. */
	const prompts = usePromptList({ page: 1, limit: 100 });
	const promptsById = new Map(
		(prompts.data?.data ?? []).map((row: PromptRow) => [row.id, row] as const),
	);

	const canWrite = usePermission(PBX_RESOURCES.phrases.permissions.write);
	const canDelete = usePermission(PBX_RESOURCES.phrases.permissions.delete);

	const [phraseDialogOpen, setPhraseDialogOpen] = useState(false);
	const [editingStep, setEditingStep] = useState<PhraseStepRow | null>(null);
	const [stepDialogOpen, setStepDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<PhraseStepRow | null>(null);

	if (phrase.isPending) {
		return <LoadingPanel label="Loading phrase" />;
	}

	/**
	 * A library prompt's id reaches a 404 here rather than a redirect, and the empty state says so:
	 * phrases and files share one table, so `/phrases/<a file's id>` is a URL somebody can construct
	 * by accident, and the server refuses it deliberately so the noun in the path stays load-bearing.
	 */
	if (phrase.error instanceof ApiError && phrase.error.status === 404) {
		return (
			<EmptyState
				title="This phrase no longer exists"
				description="It may have been deleted from another session — or the id belongs to a recording rather than to a sequence, which this page will not open."
				action={
					<Button render={<Link href={mediaTabHref("phrases")} />} variant="secondary">
						Back to phrases
					</Button>
				}
			/>
		);
	}

	if (!phrase.data) {
		return (
			<EmptyState
				title="Could not load this phrase"
				description={
					phrase.error instanceof Error ? phrase.error.message : "Try again in a moment."
				}
			/>
		);
	}

	const row = phrase.data;
	const rows = [...(steps.data ?? [])].sort(
		(a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id),
	);
	const nextOrdinal = rows.reduce((highest, step) => Math.max(highest, step.ordinal + 1), 0);
	const activeSteps = rows.filter((step) => step.enabled);

	/** Swaps two positions and sends the whole list — see the note at the top of this file. */
	function move(index: number, delta: -1 | 1): void {
		const target = index + delta;
		if (target < 0 || target >= rows.length) {
			return;
		}
		const next = [...rows];
		const current = next[index];
		const swap = next[target];
		if (current === undefined || swap === undefined) {
			return;
		}
		next[index] = swap;
		next[target] = current;
		reorder.mutate(next.map((step) => step.id));
	}

	function stepLabel(step: PhraseStepRow): string {
		const prompt = promptsById.get(step.promptId);
		return prompt ? prompt.name : `${step.promptId.slice(0, 8)}…`;
	}

	return (
		<>
			<PageHeader
				title={row.name}
				description={`${
					activeSteps.length === 0
						? "Plays nothing"
						: `Plays ${activeSteps.length} recording${activeSteps.length === 1 ? "" : "s"} in order`
				}. A phrase is selectable anywhere a single recording is — an IVR greeting, a queue announcement, a ring group's confirmation — because it is a library row with no audio of its own.`}
				actions={
					<div className="flex items-center gap-2">
						<Button render={<Link href={mediaTabHref("phrases")} />} variant="ghost">
							All phrases
						</Button>
						{canWrite ? (
							<Button variant="secondary" onClick={() => setPhraseDialogOpen(true)}>
								Rename
							</Button>
						) : null}
					</div>
				}
			/>

			{!steps.isPending && activeSteps.length === 0 ? (
				<NoticeBanner
					title="Plays nothing"
					description={
						rows.length === 0
							? "This phrase has no steps, so anything pointed at it hears silence where an announcement should be. That compiles and is legitimate — it is what a sequence looks like before it is built — but a caller cannot tell it apart from a fault."
							: "Every step here is disabled, so anything pointed at this phrase hears silence. The steps keep their places in the order."
					}
				/>
			) : null}

			<ChildCollectionCard
				title="Steps"
				description="Played top to bottom as one announcement. Each step is a recording from the library; a step cannot be another phrase, because phrases do not nest."
				rows={rows}
				isPending={steps.isPending || prompts.isPending}
				emptyTitle="No steps yet"
				emptyDescription="Add the first recording. Upload anything missing on the Prompts tab — a phrase names recordings, it does not carry audio of its own."
				addLabel="Add step"
				onAdd={
					canWrite
						? () => {
								setEditingStep(null);
								setStepDialogOpen(true);
							}
						: undefined
				}
				columns={[
					{
						key: "prompt",
						header: "Recording",
						className: "font-medium",
						cell: (step) => stepLabel(step),
					},
					{
						key: "ordinal",
						header: "Order",
						cell: (step) => (
							<span className="text-sm text-muted-foreground" data-tabular>
								{step.ordinal}
							</span>
						),
					},
					{
						key: "audio",
						header: "Audio",
						/**
						 * The preview plays the STEP's prompt, not the phrase. There is no endpoint that
						 * renders a sequence to a single stream — the media layer expands a phrase at play
						 * time, from the compiled artifact — so hearing the whole sentence means hearing each
						 * piece in turn, which is also the way to find the one that is wrong.
						 */
						cell: (step) => {
							const prompt = promptsById.get(step.promptId);
							return prompt ? <StepPlayer prompt={prompt} /> : null;
						},
					},
					{
						key: "enabled",
						header: "State",
						cell: (step) => <EnabledBadge enabled={step.enabled} />,
					},
				]}
				rowActions={(step) => {
					const index = rows.findIndex((candidate) => candidate.id === step.id);
					return (
						<RowActions
							label={`step ${stepLabel(step)}`}
							extra={
								canWrite && rows.length > 1 ? (
									<>
										<MenuItem
											disabled={index <= 0 || reorder.isPending}
											onClick={() => move(index, -1)}
										>
											Move up
										</MenuItem>
										<MenuItem
											disabled={index === rows.length - 1 || reorder.isPending}
											onClick={() => move(index, 1)}
										>
											Move down
										</MenuItem>
									</>
								) : undefined
							}
							onEdit={
								canWrite
									? () => {
											setEditingStep(step);
											setStepDialogOpen(true);
										}
									: undefined
							}
							onDelete={
								canDelete
									? () => {
											removeStep.reset();
											setPendingDelete(step);
										}
									: undefined
							}
						/>
					);
				}}
				footer={
					rows.length > 1 ? (
						<p className="text-xs text-muted-foreground">
							Move up and Move down rewrite the whole order in one request, because two steps cannot
							share a position. Deleting a recording this phrase plays is refused rather than
							allowed to shorten the sentence — the delete comes back naming this phrase.
						</p>
					) : undefined
				}
			/>

			<PhraseDialog open={phraseDialogOpen} onOpenChange={setPhraseDialogOpen} phrase={row} />

			<PhraseStepDialog
				key={editingStep?.id ?? `new-${String(nextOrdinal)}`}
				open={stepDialogOpen}
				onOpenChange={setStepDialogOpen}
				phraseId={phraseId}
				step={editingStep}
				nextOrdinal={nextOrdinal}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						removeStep.reset();
					}
				}}
				entityLabel="step"
				entityName={pendingDelete ? stepLabel(pendingDelete) : "this step"}
				description="The recording itself is untouched — it simply stops being part of this sentence, and everything after it moves up."
				pending={removeStep.isPending}
				error={removeStep.error}
				onConfirm={() => {
					if (!pendingDelete) {
						return;
					}
					removeStep.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) });
				}}
			/>
		</>
	);
}

/** One step's preview. A mint mutation per row, so pressing one does not busy the others. */
function StepPlayer({ prompt }: { readonly prompt: PromptRow }) {
	const mint = usePromptPlaybackUrl();

	return (
		<MediaPreviewButton
			mint={() => mint.mutateAsync(prompt.id)}
			label={prompt.name}
			failureMessage="This recording could not be prepared for playback."
		/>
	);
}
