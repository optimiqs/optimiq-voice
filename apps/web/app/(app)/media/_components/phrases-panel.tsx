"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { DeleteEntityDialog } from "~/components/pbx/delete-entity-dialog";
import { ListPagination, ResourceTable, useListQueryState } from "~/components/pbx/resource-list";
import { RowActions } from "~/components/pbx/row-actions";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/empty-state";
import { inputClassName } from "~/components/ui/field";
import { DEFAULT_PAGE_LIMIT, PBX_RESOURCES } from "~/lib/pbx/client";
import { routes } from "~/lib/routes";
import { usePermission } from "../../_context/session-context";
import { usePbxDelete, usePbxList } from "../../_hooks/use-pbx-queries";
import { PhraseDialog } from "./phrase-dialog";
import type { PhraseRow } from "~/lib/pbx/contracts";

/**
 * Phrases: the sequences assembled out of the prompt library.
 *
 * ## What a phrase is for
 *
 * There is no text-to-speech on this platform, so "your call is number seven in the queue" is three
 * recordings played in order. A phrase is that order, stored as a row, and it is accepted anywhere a
 * single prompt is — an IVR greeting, a queue announcement, a ring group's confirmation — because it
 * IS a `prompt` row (`kind = "phrase"`, no object key). That is the whole reason it shares a table
 * rather than getting one of its own: the eight `*_prompt_id` foreign keys already in the schema
 * accept one for free, instead of a ninth column and a second picker on every form that plays audio.
 *
 * ## Why this tab gates itself
 *
 * `/media` is reachable with `settings.read`, which every self-service role holds so a preferences
 * screen renders — and the phrases endpoints are guarded by `recordings.*`, which is the API's
 * decision: a phrase is a media-library row and rides the library's grants rather than minting a
 * `phrases.*` trio nobody would hold separately.
 *
 * The two grants therefore come apart in a direction the route requirement cannot express, and this
 * panel answers rather than the router. Somebody who can see the tab and not read the list is told
 * why, in place of an empty table that reads as "there are no phrases" — which is the failure a
 * silent 403 produces on a page whose other two tabs work.
 *
 * ## Why the list has no state filter
 *
 * `prompt` has no `enabled` column, so the shared `ListToolbar` would offer a control that does
 * nothing — the same reason the prompt library renders only the search half of `useListQueryState`.
 * It is the STEPS that carry `enabled`, because half-building a sequence is a real state.
 *
 * The steps themselves are edited on the phrase's own page: they are an ordered collection with a
 * reorder endpoint, and the order is the sentence.
 */
export function PhrasesPanel() {
	// Prefixed, because the hold-music and prompt tabs share this URL.
	const { query, search, setSearch, page, setPage } = useListQueryState("ph");

	const searchId = useId();

	const canRead = usePermission(PBX_RESOURCES.phrases.permissions.read);
	const canWrite = usePermission(PBX_RESOURCES.phrases.permissions.write);
	const canDelete = usePermission(PBX_RESOURCES.phrases.permissions.delete);

	const list = usePbxList<PhraseRow>(
		PBX_RESOURCES.phrases,
		{ page: query.page ?? 1, limit: DEFAULT_PAGE_LIMIT, search: query.search },
		{ enabled: canRead },
	);
	const remove = usePbxDelete(PBX_RESOURCES.phrases);

	const [editing, setEditing] = useState<PhraseRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<PhraseRow | null>(null);

	if (!canRead) {
		return (
			<EmptyState
				title="Phrases need the recordings grant"
				description="Hold music and the prompt library are organization settings; a phrase is a media-library row and is guarded by the same permissions as the call recordings. Your role can open this page and not this tab. An administrator can grant it under Settings → Members."
			/>
		);
	}

	const createButton = canWrite ? (
		<Button
			variant="primary"
			onClick={() => {
				setEditing(null);
				setDialogOpen(true);
			}}
		>
			New phrase
		</Button>
	) : null;

	return (
		<>
			<div className="flex flex-wrap items-end gap-3">
				<div className="flex min-w-56 flex-1 flex-col gap-1.5">
					<label htmlFor={searchId} className="text-xs font-medium text-muted-foreground">
						Search
					</label>
					<input
						id={searchId}
						type="search"
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						placeholder="Phrase name"
						className={inputClassName}
					/>
				</div>
				{createButton ? <div className="ml-auto">{createButton}</div> : null}
			</div>

			<ResourceTable
				rows={list.rows}
				isPending={list.query.isPending}
				filtered={search.length > 0}
				emptyTitle="No phrases yet"
				emptyDescription="A phrase plays several recordings in order, as one announcement — “your call is number”, “seven”, “in the queue”. Create one and it becomes selectable everywhere a single prompt is."
				emptyAction={createButton}
				caption="Prompt sequences in this organization"
				columns={[
					{
						key: "name",
						header: "Name",
						className: "font-medium",
						cell: (row) => (
							<Link
								href={routes.phrase(row.id)}
								className="text-primary underline-offset-4 hover:underline"
							>
								{row.name}
							</Link>
						),
					},
					{
						key: "steps",
						header: "Sequence",
						/**
						 * Deliberately not a step count. The list endpoint returns `prompt` rows and the steps
						 * live under `/phrases/:id/steps`, so counting them here would be one request per row
						 * on every page — and a number with no order beside it does not answer the question
						 * somebody scanning this table has, which is "what does this one say".
						 */
						cell: (row) => (
							<Link
								href={routes.phrase(row.id)}
								className="text-xs text-muted-foreground underline-offset-4 hover:underline"
							>
								Open the sequence
							</Link>
						),
					},
				]}
				rowActions={(row) => (
					<RowActions
						label={`phrase ${row.name}`}
						onEdit={
							canWrite
								? () => {
										setEditing(row);
										setDialogOpen(true);
									}
								: undefined
						}
						onDelete={
							canDelete
								? () => {
										remove.reset();
										setPendingDelete(row);
									}
								: undefined
						}
					/>
				)}
			/>

			<ListPagination
				page={page}
				limit={DEFAULT_PAGE_LIMIT}
				total={list.total}
				totalPages={list.totalPages}
				onPageChange={setPage}
			/>

			<PhraseDialog
				key={editing?.id ?? "new"}
				open={dialogOpen}
				onOpenChange={(open) => {
					setDialogOpen(open);
					if (!open) {
						setEditing(null);
					}
				}}
				phrase={editing}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="phrase"
				entityName={pendingDelete ? pendingDelete.name : "this phrase"}
				description="The sequence and its steps are removed; the recordings themselves are untouched, because a phrase owns no audio. The same eight things that can point at a prompt can point at a phrase — an IVR's greeting, a queue's announcement among them — and the delete is refused while any of them still does, with the referrers named."
				pending={remove.isPending}
				error={remove.error}
				onConfirm={() => {
					if (!pendingDelete) {
						return;
					}
					remove.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) });
				}}
			/>
		</>
	);
}
