"use client";

import { useForm } from "@tanstack/react-form";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { SwitchField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { pagingGroupFormSchema, type PagingGroupFormValues } from "~/lib/pbx/schemas";
import { usePbxCreate, usePbxUpdate } from "../../_hooks/use-pbx-queries";
import type { PagingGroupRow } from "~/lib/pbx/contracts";

/**
 * Create and edit a paging group.
 *
 * ## There is no destination picker here, and there will not be one
 *
 * Every sibling dialog in this area ends with "and where does the call go if…". This one does not,
 * because a page has nowhere to go: the pager speaks, the members' handsets auto-answer, and the
 * announcement is over when the pager hangs up. There is no unanswered state to branch out of,
 * because a page does not wait for an answer — it causes one. `paging-schema.ts` refuses the
 * columns and `paging-groups.dto.ts` refuses the keys, so adding a picker here would be inventing a
 * state the feature does not have.
 *
 * ## The timeout is not a ring time
 *
 * It is how long ONE member's auto-answered leg may take to come up before it is given up on. The
 * server's ceiling is 300 rather than a ring group's 600 for that reason: 600 is how long a HUMAN is
 * given to pick up, and nothing here is waiting for a human. The floor of 5 is there because a
 * handset reached over a WAN needs more than a moment, and a lower value would silently shrink the
 * group.
 */
function defaultsFor(group: PagingGroupRow | null): PagingGroupFormValues {
	return {
		name: group?.name ?? "",
		extensionNumber: group?.extensionNumber ?? "",
		/** `false` on a new group, matching the column's `notNull().default(false)`. See below. */
		duplex: group?.duplex ?? false,
		timeoutSeconds: group?.timeoutSeconds === undefined ? "" : String(group.timeoutSeconds),
		enabled: group?.enabled ?? true,
	};
}

export function PagingGroupDialog({
	open,
	onOpenChange,
	group,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	group: PagingGroupRow | null;
}) {
	const create = usePbxCreate(PBX_RESOURCES.pagingGroups);
	const update = usePbxUpdate(PBX_RESOURCES.pagingGroups);
	const mutation = group === null ? create : update;
	const server = useServerFieldErrors();

	const form = useForm({
		defaultValues: defaultsFor(group),
		validators: { onSubmit: pagingGroupFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = pagingGroupFormSchema.parse(value);
			server.clear();

			/**
			 * Two `null`s that mean opposite things, and the difference is the column's rather than
			 * this form's. `extensionNumber` is genuinely nullable, so `null` CLEARS it — a group that
			 * loses its number is reachable through `*81` and nothing else, which is a real state.
			 * `timeoutSeconds` is `notNull().default(30)` and declared `resettable`, so `null` puts the
			 * server default back rather than clearing the column, which is what an emptied box means.
			 */
			const body = {
				name: parsed.name,
				extensionNumber: parsed.extensionNumber,
				duplex: parsed.duplex,
				timeoutSeconds: parsed.timeoutSeconds,
				enabled: parsed.enabled,
			};

			try {
				if (group === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: group.id, values: body });
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
			title={group === null ? "New paging group" : `Edit ${group.name}`}
			description="Which handsets an announcement reaches, and whether they can answer back."
			submitLabel={group === null ? "Create paging group" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			footerNote={
				group === null
					? "Members are added on the group's page once it exists. A group with no members announces to nobody."
					: undefined
			}
		>
			<FormSection title="Group">
				<form.Field name="name">
					{(field) => (
						<TextField
							field={field}
							label="Name"
							required
							autoFocus={group === null}
							placeholder="All handsets"
							disabled={mutation.isPending}
							submitError={server.errors.name}
						/>
					)}
				</form.Field>
				<form.Field name="extensionNumber">
					{(field) => (
						<TextField
							field={field}
							label="Internal number"
							placeholder="8100"
							description="Optional. Left empty, the group is reachable only through the *81 paging feature code — which is a complete way to reach it, so there is no need to invent digits that might collide with an extension."
							disabled={mutation.isPending}
							submitError={server.errors.extensionNumber}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
				<form.Field name="timeoutSeconds">
					{(field) => (
						<TextField
							field={field}
							label="Give a handset (seconds)"
							placeholder="30"
							description="How long one member's auto-answered leg may take to come up before it is given up on. This is not a ring time — nothing here waits for a person. Blank keeps the system default."
							disabled={mutation.isPending}
							submitError={server.errors.timeoutSeconds}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="Behaviour" columns={1}>
				<form.Field name="duplex">
					{(field) => (
						<SwitchField
							field={field}
							label="Talkback"
							/**
							 * The description CHANGES with the state, and the on-state is a warning.
							 *
							 * Off is a one-way announcement and cannot surprise anybody. On opens every
							 * member's microphone at once — the server's own reasoning for defaulting this to
							 * false is that "a group that turns out to be one-way is an operator repeating
							 * themselves, a group that turns out to be duplex is fifty open microphones". A
							 * static label would let somebody flip this on a hundred-desk group without ever
							 * being told what they just did.
							 */
							description={
								field.state.value
									? "Every member's microphone is open for the whole announcement, and they can all hear each other. On a large group that is a roomful of open microphones — use it for a two-desk intercom, not for a building-wide page."
									: "Off is a one-way announcement: members hear the page and are not heard. Turn this on only for an intercom, where being answered back is the point."
							}
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
				<form.Field name="enabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Enabled"
							description="A disabled group announces to nobody, and anything pointed at it takes no effect."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
