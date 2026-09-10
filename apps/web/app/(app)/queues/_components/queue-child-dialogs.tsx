"use client";

import { useForm } from "@tanstack/react-form";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { PromptSelect } from "~/components/pbx/resource-select";
import { SwitchField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_CHILDREN } from "~/lib/pbx/client";
import { QUEUE_SKILL_LEVEL_MAX, QUEUE_SKILL_LEVEL_MIN } from "~/lib/pbx/contracts";
import {
	queueDispositionCodeFormSchema,
	queueSkillRequirementFormSchema,
	queueSurveyQuestionFormSchema,
	type QueueDispositionCodeFormValues,
	type QueueSkillRequirementFormValues,
	type QueueSurveyQuestionFormValues,
} from "~/lib/pbx/schemas";
import { usePbxChildCreate, usePbxChildUpdate } from "../../_hooks/use-pbx-queries";
import type {
	QueueDispositionCodeRow,
	QueueSkillRequirementRow,
	QueueSurveyQuestionRow,
} from "~/lib/pbx/contracts";

/**
 * The three collections a queue's after-call behaviour is built from: the wrap-up vocabulary, the
 * skills its callers need, and the survey questions.
 *
 * One file for three dialogs because they are three instances of the same four-line form and the
 * copies are where the semantics would drift — the same argument `PBX_CHILDREN` makes for declaring
 * ten resources once. Each is still its own component with its own wording: what an operator has to
 * be told about a disposition code (it is stable, reports group by it) is not what they have to be
 * told about a skill requirement (it relaxes, or it does not and the queue holds callers).
 *
 * All three are gated on `queues.write` by the caller — the same grant as the queue's own settings,
 * which is the API's split rather than this app's: these are what the queue asks about its own
 * calls, while staffing the floor is `queues.manage-agents` and lives on the tier table.
 */
function defaultDispositionCode(
	row: QueueDispositionCodeRow | null,
): QueueDispositionCodeFormValues {
	return {
		code: row?.code ?? "",
		label: row?.label ?? "",
		position: row === null ? "" : String(row.position),
		enabled: row?.enabled ?? true,
	};
}

export function QueueDispositionCodeDialog({
	open,
	onOpenChange,
	queueId,
	code,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	queueId: string;
	code: QueueDispositionCodeRow | null;
}) {
	const child = PBX_CHILDREN.queueDispositionCodes;
	const create = usePbxChildCreate(child, "queues", queueId);
	const update = usePbxChildUpdate(child, "queues", queueId);
	const mutation = code === null ? create : update;
	const server = useServerFieldErrors();

	const form = useForm({
		defaultValues: defaultDispositionCode(code),
		validators: { onSubmit: queueDispositionCodeFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = queueDispositionCodeFormSchema.parse(value);
			server.clear();
			try {
				if (code === null) {
					await create.mutateAsync({ ...parsed });
				} else {
					await update.mutateAsync({ id: code.id, values: { ...parsed } });
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
			title={code === null ? "New wrap-up code" : `Edit ${code.label}`}
			description="One outcome the agent can close a call with. The console offers these in order once the call ends."
			submitLabel={code === null ? "Add code" : "Save code"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			footerNote="Retire a code by turning it off rather than deleting it: the calls already closed with it point at this row, and that history is what the vocabulary is for."
		>
			<FormSection title="Code">
				<form.Field name="code">
					{(field) => (
						<TextField
							field={field}
							label="Code"
							required
							autoFocus={code === null}
							placeholder="wrong-number"
							description="Lower-case, stable, and what every report groups by. Changing it later splits one outcome into two."
							disabled={mutation.isPending}
							submitError={server.errors.code}
						/>
					)}
				</form.Field>
				<form.Field name="label">
					{(field) => (
						<TextField
							field={field}
							label="What the agent sees"
							required
							placeholder="Wrong number"
							description="Free to change without breaking a report."
							disabled={mutation.isPending}
							submitError={server.errors.label}
						/>
					)}
				</form.Field>
				<form.Field name="position">
					{(field) => (
						<TextField
							field={field}
							label="Position in the list"
							placeholder="1"
							description="Lowest first; ties fall back to the code. Leave it empty for the server's default."
							disabled={mutation.isPending}
							submitError={server.errors.position}
						/>
					)}
				</form.Field>
				<form.Field name="enabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Offered"
							description="A code that is off stays on the calls it already closed and stops being offered."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}

function defaultSkillRequirement(
	row: QueueSkillRequirementRow | null,
): QueueSkillRequirementFormValues {
	return {
		skill: row?.skill ?? "",
		minLevel: row === null ? "" : String(row.minLevel),
		relaxAfterSeconds: row === null ? "" : String(row.relaxAfterSeconds),
	};
}

export function QueueSkillRequirementDialog({
	open,
	onOpenChange,
	queueId,
	requirement,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	queueId: string;
	requirement: QueueSkillRequirementRow | null;
}) {
	const child = PBX_CHILDREN.queueSkillRequirements;
	const create = usePbxChildCreate(child, "queues", queueId);
	const update = usePbxChildUpdate(child, "queues", queueId);
	const mutation = requirement === null ? create : update;
	const server = useServerFieldErrors();

	const form = useForm({
		defaultValues: defaultSkillRequirement(requirement),
		validators: { onSubmit: queueSkillRequirementFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = queueSkillRequirementFormSchema.parse(value);
			server.clear();
			try {
				if (requirement === null) {
					await create.mutateAsync({ ...parsed });
				} else {
					await update.mutateAsync({ id: requirement.id, values: { ...parsed } });
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
			title={requirement === null ? "New skill requirement" : `Edit ${requirement.skill}`}
			description="Something this queue's callers need from whoever answers, and how fast the queue stops insisting on it."
			submitLabel={requirement === null ? "Add requirement" : "Save requirement"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			footerNote="An agent's own skills are on their record, not here — the same person carries them into every queue they staff."
		>
			<FormSection title="Requirement">
				<form.Field name="skill">
					{(field) => (
						<TextField
							field={field}
							label="Skill"
							required
							autoFocus={requirement === null}
							placeholder="spanish"
							description="Lower-case, and spelled exactly as it is on the agents. The two are compared literally."
							disabled={mutation.isPending}
							submitError={server.errors.skill}
						/>
					)}
				</form.Field>
				<form.Field name="minLevel">
					{(field) => (
						<TextField
							field={field}
							label="Level needed"
							placeholder={String(QUEUE_SKILL_LEVEL_MIN)}
							description={`${String(QUEUE_SKILL_LEVEL_MIN)}–${String(QUEUE_SKILL_LEVEL_MAX)}. An agent below it is not offered a caller who has just arrived.`}
							disabled={mutation.isPending}
							submitError={server.errors.minLevel}
						/>
					)}
				</form.Field>
				<form.Field name="relaxAfterSeconds">
					{(field) => (
						<TextField
							field={field}
							label="Drop a level every (seconds)"
							placeholder="0"
							description="0 never relaxes, which makes this absolute — right for a regulated skill, and how a queue with one qualified agent holds callers until the wait cap."
							disabled={mutation.isPending}
							submitError={server.errors.relaxAfterSeconds}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}

function defaultSurveyQuestion(row: QueueSurveyQuestionRow | null): QueueSurveyQuestionFormValues {
	return {
		position: row === null ? "" : String(row.position),
		promptId: row?.promptId ?? "",
		label: row?.label ?? "",
	};
}

export function QueueSurveyQuestionDialog({
	open,
	onOpenChange,
	queueId,
	question,
	suggestedPosition,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	queueId: string;
	question: QueueSurveyQuestionRow | null;
	/** The next free position, so the common case needs no arithmetic. */
	suggestedPosition?: number;
}) {
	const child = PBX_CHILDREN.queueSurveyQuestions;
	const create = usePbxChildCreate(child, "queues", queueId);
	const update = usePbxChildUpdate(child, "queues", queueId);
	const mutation = question === null ? create : update;
	const server = useServerFieldErrors();

	const form = useForm({
		defaultValues:
			question === null && suggestedPosition !== undefined
				? { ...defaultSurveyQuestion(null), position: String(suggestedPosition) }
				: defaultSurveyQuestion(question),
		validators: { onSubmit: queueSurveyQuestionFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = queueSurveyQuestionFormSchema.parse(value);
			server.clear();
			try {
				if (question === null) {
					await create.mutateAsync({ ...parsed });
				} else {
					await update.mutateAsync({ id: question.id, values: { ...parsed } });
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
			title={question === null ? "New survey question" : `Edit ${question.label}`}
			description="One question the caller is asked after the agent hangs up. They answer with a digit, 1 to 5."
			submitLabel={question === null ? "Add question" : "Save question"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			footerNote="The position is the question's identity in every report, not a display order — moving a question renumbers what last month's answers are filed under. Three is the ceiling: it is the attention a caller has."
		>
			<FormSection title="Question">
				<form.Field name="position">
					{(field) => (
						<TextField
							field={field}
							label="Asked"
							required
							placeholder="1"
							description="1, 2 or 3 — and the number reports group by."
							disabled={mutation.isPending}
							submitError={server.errors.position}
						/>
					)}
				</form.Field>
				<form.Field name="label">
					{(field) => (
						<TextField
							field={field}
							label="What the report calls it"
							required
							autoFocus={question === null}
							placeholder="Did we solve your problem?"
							description="For the console and the report. The caller never hears it."
							disabled={mutation.isPending}
							submitError={server.errors.label}
						/>
					)}
				</form.Field>
				<form.Field name="promptId">
					{(field) => (
						<PromptSelect
							id="queueSurveyQuestionPromptId"
							label="What the caller hears"
							value={field.state.value}
							onChange={(next) => field.handleChange(next)}
							emptyLabel="Nothing — the question is silent"
							description="'Press 1 to 5 to rate how well we answered your question.' Without it the caller is asked for a digit with no question attached."
							disabled={mutation.isPending}
							error={server.errors.promptId}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
