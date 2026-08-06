"use client";

import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { ResourceSelect } from "~/components/pbx/resource-select";
import { TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_CHILDREN, PBX_RESOURCES } from "~/lib/pbx/client";
import { queueTierFormSchema, type QueueTierFormValues } from "~/lib/pbx/schemas";
import { usePbxChildCreate, usePbxChildUpdate } from "../../_hooks/use-pbx-queries";
import type { QueueTierRow } from "~/lib/pbx/contracts";

/**
 * A tier: this agent serves this queue, at this level and in this order within it.
 *
 * ## One dialog, two directions
 *
 * A membership joins two things and can be created from either end — "staff this queue with Alice"
 * on the queue's page, "put Alice in Support" from the agent list. Both write the same row through
 * the same endpoint, so there is one dialog: whichever end the caller came from is `fixed`, and the
 * other is the thing being chosen. Two dialogs would be the same form twice, and the second copy is
 * where the `(level, position)` semantics would drift.
 *
 * ## There is no reorder here
 *
 * Every other child collection in this app has an `ordinal` and a reorder endpoint. A tier does not,
 * deliberately: its place is `(level, position)`, which the caller states because it decides who is
 * offered the call first. Lower levels are tried first and every agent at a level is tried before
 * the next one; `position` orders agents within a level, which `top-down` and `round-robin` walk in.
 * That is routing policy, not a drag handle, so it is typed rather than dragged.
 */
function defaultsFor(
	tier: QueueTierRow | null,
	fixed: { readonly queueId?: string; readonly agentId?: string; readonly position?: number },
): QueueTierFormValues {
	if (tier !== null) {
		return {
			queueId: tier.queueId,
			queueAgentId: tier.queueAgentId,
			level: String(tier.level),
			position: String(tier.position),
		};
	}
	return {
		queueId: fixed.queueId ?? "",
		queueAgentId: fixed.agentId ?? "",
		level: "",
		position: fixed.position === undefined ? "" : String(fixed.position),
	};
}

export function QueueTierDialog({
	open,
	onOpenChange,
	tier,
	fixedQueueId,
	fixedAgentId,
	suggestedPosition,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	tier: QueueTierRow | null;
	/** Set when opened from a queue's page: the queue is context, not a choice. */
	fixedQueueId?: string;
	/** Set when opened from the agent list: the agent is context, not a choice. */
	fixedAgentId?: string;
	/** The next free position at level 1, so the common case needs no arithmetic. */
	suggestedPosition?: number;
}) {
	const child = PBX_CHILDREN.queueTiers;
	const server = useServerFieldErrors();

	const [queueId, setQueueId] = useState(tier?.queueId ?? fixedQueueId ?? "");
	const [agentId, setAgentId] = useState(tier?.queueAgentId ?? fixedAgentId ?? "");

	/**
	 * The parent is the SELECTED queue, not a prop: from the agent side it is chosen inside this
	 * dialog, and the mutation must post to `/queues/<that one>/tiers`.
	 */
	const create = usePbxChildCreate(child, "queues", queueId);
	const update = usePbxChildUpdate(child, "queues", queueId);
	const mutation = tier === null ? create : update;

	const form = useForm({
		defaultValues: defaultsFor(tier, {
			queueId: fixedQueueId,
			agentId: fixedAgentId,
			position: suggestedPosition,
		}),
		validators: { onSubmit: queueTierFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = queueTierFormSchema.parse({ ...value, queueId, queueAgentId: agentId });
			server.clear();

			// `queueId` is the path segment, never the body — the same rule every child collection
			// follows, and the reason a tier cannot be moved between queues by editing it.
			const body = {
				queueAgentId: parsed.queueAgentId,
				level: parsed.level,
				position: parsed.position,
			};

			try {
				if (tier === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: tier.id, values: body });
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
					setQueueId(tier?.queueId ?? fixedQueueId ?? "");
					setAgentId(tier?.queueAgentId ?? fixedAgentId ?? "");
					form.reset();
				}
				onOpenChange(next);
			}}
			title={tier === null ? "Staff this queue" : "Edit membership"}
			description="Which agent serves this queue, at which ring level, and in what order within it."
			submitLabel={tier === null ? "Add agent" : "Save membership"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			footerNote="Lower levels are offered the call first, and every agent at a level is tried before the next one. A membership cannot be moved between queues — remove it and add it where it belongs."
		>
			<FormSection title="Membership">
				{fixedQueueId === undefined ? (
					<ResourceSelect
						id="queueId"
						label="Queue"
						resource={PBX_RESOURCES.queues}
						value={queueId}
						onChange={setQueueId}
						allowEmpty={false}
						// The queue this tier already belongs to cannot change: it is the endpoint's path.
						disabled={mutation.isPending || tier !== null}
						error={server.errors.queueId}
						className="sm:col-span-2"
					/>
				) : null}
				{fixedAgentId === undefined ? (
					<ResourceSelect
						id="queueAgentId"
						label="Agent"
						description="Only enabled agents are listed — staffing a queue with a disabled one adds a seat that never rings."
						resource={PBX_RESOURCES.queueAgents}
						value={agentId}
						onChange={setAgentId}
						allowEmpty={false}
						disabled={mutation.isPending}
						error={server.errors.queueAgentId}
						className="sm:col-span-2"
					/>
				) : null}
				<form.Field name="level">
					{(field) => (
						<TextField
							field={field}
							label="Level"
							placeholder="1"
							description="Lower is tried first. Leave it empty for the server's default."
							disabled={mutation.isPending}
							submitError={server.errors.level}
						/>
					)}
				</form.Field>
				<form.Field name="position">
					{(field) => (
						<TextField
							field={field}
							label="Position in the level"
							placeholder="1"
							description="The order top-down and round-robin walk in."
							disabled={mutation.isPending}
							submitError={server.errors.position}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
