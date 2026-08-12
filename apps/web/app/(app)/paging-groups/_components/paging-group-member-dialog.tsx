"use client";

import { useForm } from "@tanstack/react-form";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { ResourceSelect } from "~/components/pbx/resource-select";
import { SwitchField, TextField } from "~/components/ui/form-fields";
import { getFieldErrorMessage } from "~/lib/forms/field-errors";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_CHILDREN, PBX_RESOURCES } from "~/lib/pbx/client";
import { pagingGroupMemberFormSchema, type PagingGroupMemberFormValues } from "~/lib/pbx/schemas";
import { usePbxChildCreate, usePbxChildUpdate } from "../../_hooks/use-pbx-queries";
import type { PagingGroupMemberRow } from "~/lib/pbx/contracts";

/**
 * One handset in a paging group.
 *
 * ## Why this is an extension picker and not a destination picker
 *
 * A ring-group member carries a destination trio, which is what lets a group ring a mobile over a
 * trunk or fall into another group. A paging member carries an `extension_id` and nothing else,
 * because the engine ORIGINATES an auto-answered leg to it: an external number cannot be told to
 * pick up, and a nested group would be a fan-out whose depth nobody bounded. So the control here is
 * a list of extensions, and the foreign key is what enforces that a member resolves to a real
 * endpoint rather than to a name somebody typed.
 *
 * ## The order is the operator's, which is why it is editable
 *
 * An announcement to a hundred desks is fanned out rather than originated in one instant, so the
 * order in which the fan-out proceeds is a decision. Without the column it would be whatever the
 * loader's `ORDER BY` happened to be. This box sets it directly for the case where somebody knows
 * the number they want; the group's page has Move up / Move down for the ordinary case, which go
 * through `PUT …/members/reorder` and rewrite the whole order in one transaction.
 *
 * `(group, ordinal)` is UNIQUE, so two members cannot claim the same position — a collision here
 * comes back as a `PBX_CONFLICT` attached to this field rather than as a silent reshuffle.
 */
function defaultsFor(
	member: PagingGroupMemberRow | null,
	nextOrdinal: number,
): PagingGroupMemberFormValues {
	return {
		extensionId: member?.extensionId ?? "",
		ordinal: member === null ? String(nextOrdinal) : String(member.ordinal),
		enabled: member?.enabled ?? true,
	};
}

export function PagingGroupMemberDialog({
	open,
	onOpenChange,
	groupId,
	member,
	nextOrdinal,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	groupId: string;
	member: PagingGroupMemberRow | null;
	nextOrdinal: number;
}) {
	const child = PBX_CHILDREN.pagingGroupMembers;
	const create = usePbxChildCreate(child, "paging-groups", groupId);
	const update = usePbxChildUpdate(child, "paging-groups", groupId);
	const mutation = member === null ? create : update;
	const server = useServerFieldErrors();

	const form = useForm({
		defaultValues: defaultsFor(member, nextOrdinal),
		validators: { onSubmit: pagingGroupMemberFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = pagingGroupMemberFormSchema.parse(value);
			server.clear();

			/**
			 * `ordinal` is REQUIRED by the create DTO — it is not `resettable`, because there is no
			 * server default for "where in the fan-out". The box is pre-filled with the next free
			 * position, so the `?? 0` is only reached by somebody who cleared it on purpose.
			 */
			const body = {
				extensionId: parsed.extensionId,
				ordinal: parsed.ordinal ?? 0,
				enabled: parsed.enabled,
			};

			try {
				if (member === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: member.id, values: body });
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
			title={member === null ? "Add member" : "Edit member"}
			description="Which handset the announcement reaches, and where it sits in the fan-out."
			submitLabel={member === null ? "Add member" : "Save member"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
		>
			<FormSection title="Handset">
				<form.Field name="extensionId">
					{(field) => (
						<ResourceSelect
							id="pagingMemberExtensionId"
							label="Extension"
							resource={PBX_RESOURCES.extensions}
							value={field.state.value}
							onChange={(next) => field.handleChange(next)}
							allowEmpty={false}
							placeholder="Choose an extension…"
							description="Only extensions, because the engine auto-answers a leg to each member — an external number cannot be told to pick up. The handset itself must also be configured to auto-answer, which is a phone setting rather than something this page can set."
							disabled={mutation.isPending}
							/**
							 * `ResourceSelect` is not a `FieldLike` adapter, so it does not resolve its own
							 * error the way `TextField` does. The client validator comes first here for the
							 * same reason it does there: "Required" belongs on the control before the request
							 * is made, not after the server has answered.
							 */
							error={getFieldErrorMessage(field.state.meta.errors) ?? server.errors.extensionId}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
				<form.Field name="ordinal">
					{(field) => (
						<TextField
							field={field}
							label="Order"
							placeholder="0"
							description="Where this handset sits in the fan-out. Two members cannot share a position — use Move up and Move down on the group's page to shuffle the whole list at once."
							disabled={mutation.isPending}
							submitError={server.errors.ordinal}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="Behaviour" columns={1}>
				<form.Field name="enabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Enabled"
							description="A disabled member stays in the list and is skipped by the announcement."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
