"use client";

import { useForm } from "@tanstack/react-form";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/form-fields";
import { LoadingPanel } from "~/components/ui/spinner";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_CHILDREN } from "~/lib/pbx/client";
import { QUEUE_SKILL_LEVEL_MAX, QUEUE_SKILL_LEVEL_MIN } from "~/lib/pbx/contracts";
import { queueAgentSkillFormSchema } from "~/lib/pbx/schemas";
import { usePbxChildCreate, usePbxChildDelete, usePbxChildren } from "../../_hooks/use-pbx-queries";
import type { QueueAgentRow, QueueAgentSkillRow } from "~/lib/pbx/contracts";

/**
 * What one agent is good at.
 *
 * ## Why this is a list editor and not the usual one-row form
 *
 * Every other child collection in this app is a table on a detail PAGE with a dialog per row. An
 * agent has no detail page — the roster is a list — and a skill is two short fields, so a dialog per
 * skill on top of a dialog per agent would be two modals deep to type `spanish` and `4`. So the
 * dialog IS the collection: the rows are above, the add form is below, and it stays open after a
 * save because adding three skills is the normal case rather than the exception.
 *
 * The shared form shell still carries it, which is what keeps Enter working and the rollback banner
 * honest — the two things a hand-rolled modal here would lose.
 *
 * ## Why the skill hangs off the person
 *
 * `queue_agent_skill` has no queue: the same agent carries `spanish: 4` into every queue they staff,
 * and a copy per membership would be a second value somebody has to keep in step. It is
 * `queues.manage-agents` for the same reason a tier is — whoever staffs the floor is whoever knows
 * what each person can do.
 */
export function QueueAgentSkillsDialog({
	open,
	onOpenChange,
	agent,
	canManage,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	agent: QueueAgentRow;
	canManage: boolean;
}) {
	const child = PBX_CHILDREN.queueAgentSkills;
	const skills = usePbxChildren<QueueAgentSkillRow>(child, "queue-agents", agent.id);
	const create = usePbxChildCreate(child, "queue-agents", agent.id);
	const remove = usePbxChildDelete(child, "queue-agents", agent.id);
	const server = useServerFieldErrors();

	const rows = [...(skills.data ?? [])].sort((a, b) => a.skill.localeCompare(b.skill));

	const form = useForm({
		defaultValues: { skill: "", level: "" },
		validators: { onSubmit: queueAgentSkillFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = queueAgentSkillFormSchema.parse(value);
			server.clear();
			try {
				await create.mutateAsync({ ...parsed });
				// The dialog deliberately stays open: this is the collection, and one skill is rarely
				// the whole answer.
				form.reset();
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
					create.reset();
					remove.reset();
					form.reset();
				}
				onOpenChange(next);
			}}
			title={`${agent.name}'s skills`}
			description="What this agent can take. A queue with a skill requirement offers callers only to agents who reach its level."
			submitLabel="Add skill"
			pending={create.isPending}
			error={create.error ?? remove.error}
			onSubmit={() => void form.handleSubmit()}
			footerNote="A skill belongs to the person, not to a queue: the same tag counts on every queue they serve. Spelling is compared literally, so it must match the queue's requirement exactly."
		>
			<FormSection title="Skills" columns={1}>
				{skills.isPending ? (
					<LoadingPanel label="Loading skills" />
				) : rows.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No skills recorded, so this agent is passed over by every queue that requires one.
					</p>
				) : (
					<ul className="flex flex-col gap-2">
						{rows.map((row) => (
							<li
								key={row.id}
								className="flex items-center gap-3 rounded-panel border border-border bg-canvas px-3 py-2"
							>
								<span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
									{row.skill}
								</span>
								<Badge tone="accent" data-tabular>
									Level {row.level}
								</Badge>
								{canManage ? (
									<Button
										size="sm"
										variant="ghost"
										loading={remove.isPending}
										onClick={() => remove.mutate(row.id)}
										aria-label={`Remove ${row.skill} from ${agent.name}`}
									>
										Remove
									</Button>
								) : null}
							</li>
						))}
					</ul>
				)}
			</FormSection>

			{canManage ? (
				<FormSection title="Add a skill">
					<form.Field name="skill">
						{(field) => (
							<TextField
								field={field}
								label="Skill"
								required
								placeholder="spanish"
								description="Lower-case, and spelled exactly as the queue's requirement spells it."
								disabled={create.isPending}
								submitError={server.errors.skill}
							/>
						)}
					</form.Field>
					<form.Field name="level">
						{(field) => (
							<TextField
								field={field}
								label="Level"
								placeholder={String(QUEUE_SKILL_LEVEL_MIN)}
								description={`${String(QUEUE_SKILL_LEVEL_MIN)}–${String(QUEUE_SKILL_LEVEL_MAX)}. Empty is the lowest.`}
								disabled={create.isPending}
								submitError={server.errors.level}
							/>
						)}
					</form.Field>
				</FormSection>
			) : null}
		</EntityFormDialog>
	);
}
