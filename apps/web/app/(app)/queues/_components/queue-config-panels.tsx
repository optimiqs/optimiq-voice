"use client";

import { useState } from "react";
import { ChildCollectionCard } from "~/components/pbx/child-collection";
import { DeleteEntityDialog } from "~/components/pbx/delete-entity-dialog";
import { EnabledBadge } from "~/components/pbx/resource-list";
import { RowActions } from "~/components/pbx/row-actions";
import { Badge } from "~/components/ui/badge";
import { PBX_CHILDREN } from "~/lib/pbx/client";
import { QUEUE_SURVEY_MAX_QUESTIONS } from "~/lib/pbx/contracts";
import { usePbxChildDelete, usePbxChildren } from "../../_hooks/use-pbx-queries";
import {
	QueueDispositionCodeDialog,
	QueueSkillRequirementDialog,
	QueueSurveyQuestionDialog,
} from "./queue-child-dialogs";
import type {
	QueueDispositionCodeRow,
	QueueSkillRequirementRow,
	QueueSurveyQuestionRow,
} from "~/lib/pbx/contracts";

/**
 * The three collections that decide what happens either side of a queue call, as panels for the
 * queue's own page.
 *
 * They sit here rather than in `queue-detail.tsx` because that file is already the page's two
 * permissions, its live tiles and its membership table, and three more collections with three
 * delete confirmations would have doubled it. Each panel owns its own query, its own dialog and its
 * own confirmation, which is the arrangement the tier table has — just factored so the page reads
 * as a list of panels.
 *
 * All three are `queues.write`, and the caller passes that in rather than resolving it three times.
 * An `onAdd` that is `undefined` REMOVES the button rather than disabling it, which is the rule
 * every other collection in this app follows: a control a reader may not use is not a control.
 */
export function QueueDispositionCodesPanel({
	queueId,
	canWrite,
	dispositionRequired,
}: {
	queueId: string;
	canWrite: boolean;
	/** Only to say something true in the empty state — the switch is on the queue's own form. */
	dispositionRequired: boolean;
}) {
	const codes = usePbxChildren<QueueDispositionCodeRow>(
		PBX_CHILDREN.queueDispositionCodes,
		"queues",
		queueId,
	);
	const remove = usePbxChildDelete(PBX_CHILDREN.queueDispositionCodes, "queues", queueId);

	const [editing, setEditing] = useState<QueueDispositionCodeRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<QueueDispositionCodeRow | null>(null);

	const rows = [...(codes.data ?? [])].sort(
		(a, b) => a.position - b.position || a.code.localeCompare(b.code),
	);

	return (
		<>
			<ChildCollectionCard
				title="Wrap-up codes"
				description="What an agent can close a call with. The console offers these in this order once the call ends, and every report groups by the code rather than by the label."
				rows={rows}
				isPending={codes.isPending}
				emptyTitle="This queue asks no wrap-up question"
				emptyDescription={
					dispositionRequired
						? "Queue settings say a code is required, but there are none to pick — so the setting does nothing and every call is recorded as 'unset'. Add the outcomes this queue's calls actually have."
						: "Add the outcomes this queue's calls actually have, and the console will ask the agent for one when the call ends."
				}
				addLabel="Add code"
				onAdd={
					canWrite
						? () => {
								setEditing(null);
								setDialogOpen(true);
							}
						: undefined
				}
				columns={[
					{
						key: "label",
						header: "What the agent sees",
						className: "font-medium",
						cell: (row) => row.label,
					},
					{
						key: "code",
						header: "Code",
						cell: (row) => <Badge tone="neutral">{row.code}</Badge>,
					},
					{
						key: "position",
						header: "Position",
						cell: (row) => (
							<span className="text-sm text-muted-foreground" data-tabular>
								{row.position}
							</span>
						),
					},
					{
						key: "enabled",
						header: "State",
						cell: (row) => <EnabledBadge enabled={row.enabled} />,
					},
				]}
				rowActions={(row) => (
					<RowActions
						label={`wrap-up code ${row.label}`}
						onEdit={
							canWrite
								? () => {
										setEditing(row);
										setDialogOpen(true);
									}
								: undefined
						}
						onDelete={
							canWrite
								? () => {
										remove.reset();
										setPendingDelete(row);
									}
								: undefined
						}
					/>
				)}
			/>

			<QueueDispositionCodeDialog
				key={editing?.id ?? "new-code"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				queueId={queueId}
				code={editing}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="wrap-up code"
				entityName={pendingDelete ? pendingDelete.label : "this code"}
				description="The calls already closed with it keep the code they were filed under, so past reports are unchanged. Turning it off instead keeps the row and simply stops offering it."
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

export function QueueSkillRequirementsPanel({
	queueId,
	canWrite,
}: {
	queueId: string;
	canWrite: boolean;
}) {
	const requirements = usePbxChildren<QueueSkillRequirementRow>(
		PBX_CHILDREN.queueSkillRequirements,
		"queues",
		queueId,
	);
	const remove = usePbxChildDelete(PBX_CHILDREN.queueSkillRequirements, "queues", queueId);

	const [editing, setEditing] = useState<QueueSkillRequirementRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<QueueSkillRequirementRow | null>(null);

	const rows = [...(requirements.data ?? [])].sort((a, b) => a.skill.localeCompare(b.skill));

	return (
		<>
			<ChildCollectionCard
				title="Skills this queue needs"
				description="Narrows who a caller may be offered to. An agent below the level is skipped until the requirement relaxes — and a requirement that never relaxes is absolute, which is the right answer for a regulated skill and the wrong one for a preference."
				rows={rows}
				isPending={requirements.isPending}
				emptyTitle="Any staffed agent may take these calls"
				emptyDescription="Add a skill to narrow that. Agents carry their own skills on their record, and the two are matched by the tag spelled exactly the same way."
				addLabel="Add requirement"
				onAdd={
					canWrite
						? () => {
								setEditing(null);
								setDialogOpen(true);
							}
						: undefined
				}
				columns={[
					{
						key: "skill",
						header: "Skill",
						className: "font-medium",
						cell: (row) => row.skill,
					},
					{
						key: "minLevel",
						header: "Level needed",
						cell: (row) => (
							<span className="text-sm" data-tabular>
								{row.minLevel}
							</span>
						),
					},
					{
						key: "relax",
						header: "Relaxes",
						cell: (row) =>
							row.relaxAfterSeconds === 0 ? (
								<Badge tone="warning">Never — absolute</Badge>
							) : (
								<span className="text-sm text-muted-foreground" data-tabular>
									a level every {row.relaxAfterSeconds}s
								</span>
							),
					},
				]}
				rowActions={(row) => (
					<RowActions
						label={`skill requirement ${row.skill}`}
						onEdit={
							canWrite
								? () => {
										setEditing(row);
										setDialogOpen(true);
									}
								: undefined
						}
						onDelete={
							canWrite
								? () => {
										remove.reset();
										setPendingDelete(row);
									}
								: undefined
						}
					/>
				)}
			/>

			<QueueSkillRequirementDialog
				key={editing?.id ?? "new-requirement"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				queueId={queueId}
				requirement={editing}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="skill requirement"
				entityName={pendingDelete ? pendingDelete.skill : "this requirement"}
				description="Callers on this queue stop being filtered by it from the next distribution pass. The agents keep the skill on their own records."
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

export function QueueSurveyQuestionsPanel({
	queueId,
	canWrite,
	surveyEnabled,
}: {
	queueId: string;
	canWrite: boolean;
	/** Only to say something true in the empty state — the switch is on the queue's own form. */
	surveyEnabled: boolean;
}) {
	const questions = usePbxChildren<QueueSurveyQuestionRow>(
		PBX_CHILDREN.queueSurveyQuestions,
		"queues",
		queueId,
	);
	const remove = usePbxChildDelete(PBX_CHILDREN.queueSurveyQuestions, "queues", queueId);

	const [editing, setEditing] = useState<QueueSurveyQuestionRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<QueueSurveyQuestionRow | null>(null);

	const rows = [...(questions.data ?? [])].sort((a, b) => a.position - b.position);
	/** The lowest free position, so "Add question" lands somewhere the unique index accepts. */
	const taken = new Set(rows.map((row) => row.position));
	const nextPosition = [1, 2, 3].find((position) => !taken.has(position));
	const full = rows.length >= QUEUE_SURVEY_MAX_QUESTIONS;

	return (
		<>
			<ChildCollectionCard
				title="Post-call survey"
				description="Asked after the agent hangs up, on answered calls only. The caller answers each with one digit, 1 to 5."
				rows={rows}
				isPending={questions.isPending}
				emptyTitle="No questions"
				emptyDescription={
					surveyEnabled
						? "Queue settings offer a survey, but there is nothing to ask — so the caller hears the introduction and then nothing. Add up to three questions."
						: "Add up to three questions, then turn the survey on in the queue's settings. Three is the ceiling because three keypresses is the attention a caller has."
				}
				addLabel="Add question"
				onAdd={
					canWrite && !full
						? () => {
								setEditing(null);
								setDialogOpen(true);
							}
						: undefined
				}
				columns={[
					{
						key: "position",
						header: "Asked",
						cell: (row) => (
							<span className="text-sm" data-tabular>
								{row.position}
							</span>
						),
					},
					{
						key: "label",
						header: "What the report calls it",
						className: "font-medium",
						cell: (row) => row.label,
					},
					{
						key: "prompt",
						header: "What the caller hears",
						cell: (row) =>
							row.promptId ? (
								<Badge tone="neutral">A prompt</Badge>
							) : (
								<Badge tone="warning">Silent</Badge>
							),
					},
				]}
				rowActions={(row) => (
					<RowActions
						label={`survey question ${row.label}`}
						onEdit={
							canWrite
								? () => {
										setEditing(row);
										setDialogOpen(true);
									}
								: undefined
						}
						onDelete={
							canWrite
								? () => {
										remove.reset();
										setPendingDelete(row);
									}
								: undefined
						}
					/>
				)}
				footer={
					full ? (
						<p className="text-xs text-muted-foreground">
							Three questions is the ceiling the database enforces. Replace one rather than adding a
							fourth.
						</p>
					) : undefined
				}
			/>

			<QueueSurveyQuestionDialog
				key={editing?.id ?? `new-question-${String(nextPosition ?? 0)}`}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				queueId={queueId}
				question={editing}
				{...(nextPosition === undefined ? {} : { suggestedPosition: nextPosition })}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="survey question"
				entityName={pendingDelete ? pendingDelete.label : "this question"}
				description="The answers already given go with it — they are rows against this question, and nothing else identifies what was asked."
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
