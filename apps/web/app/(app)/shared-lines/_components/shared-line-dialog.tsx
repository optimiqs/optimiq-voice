"use client";

import { useForm } from "@tanstack/react-form";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { SelectField, SwitchField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { SHARED_LINE_STRATEGIES } from "~/lib/pbx/contracts";
import { sharedLineFormSchema, type SharedLineFormValues } from "~/lib/pbx/schemas";
import { usePbxCreate, usePbxUpdate } from "../../_hooks/use-pbx-queries";
import type { SharedLineRow } from "~/lib/pbx/contracts";

/** How the appearances are offered a call to the line's number. */
const STRATEGY_LABELS: Readonly<Record<SharedLineRow["strategy"], string>> = {
	simultaneous: "All at once (ring every appearance)",
	sequential: "In order (walk the appearances)",
};

/**
 * Create and edit a shared line.
 *
 * ## There is no destination picker here, and there will not be one
 *
 * Every sibling dialog in this area ends with "and where does the call go if…". This one does not,
 * for the same reason the paging dialog does not: a shared line has nowhere to continue to. It never
 * routes a call out — its whole point is the state it keeps AFTER the answer, which lives in a KV
 * claim the engine arbitrates. `shared-lines.dto.ts` refuses the keys and `sharedLineFormSchema` is
 * a strict object, so adding a picker here would be inventing a state the feature does not have.
 *
 * ## The recall timeout, and why 0 is a real value
 *
 * `0` disables recall — the line holds a call indefinitely, which is the plain-hold default — where
 * every other number on this form treats an emptied box as "restore the server default". Both are
 * `null` on the wire and the difference is the column's: `hold_recall_timeout_seconds` takes 0 as a
 * value, so the floor is 0 and the copy says what 0 means rather than leaving the operator to guess.
 *
 * ## Barge-in is stored and compiled, and does not act yet
 *
 * The switch records intent. The live barge-in MEDIA join — an idle appearance stepping into a call
 * already up on the line — awaits the media plane; the flag is stored and compiled into the artifact
 * today, but no call joins on it. The note says so rather than implying a behaviour that has not
 * landed.
 */
function defaultsFor(line: SharedLineRow | null): SharedLineFormValues {
	return {
		name: line?.name ?? "",
		extensionNumber: line?.extensionNumber ?? "",
		strategy: line?.strategy ?? "simultaneous",
		ringTimeoutSeconds:
			line?.ringTimeoutSeconds === undefined ? "" : String(line.ringTimeoutSeconds),
		holdRecallTimeoutSeconds:
			line?.holdRecallTimeoutSeconds === undefined ? "" : String(line.holdRecallTimeoutSeconds),
		/** `false` on a new line, matching the column's `notNull().default(false)`. */
		bargeInEnabled: line?.bargeInEnabled ?? false,
		enabled: line?.enabled ?? true,
	};
}

export function SharedLineDialog({
	open,
	onOpenChange,
	line,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	line: SharedLineRow | null;
}) {
	const create = usePbxCreate(PBX_RESOURCES.sharedLines);
	const update = usePbxUpdate(PBX_RESOURCES.sharedLines);
	const mutation = line === null ? create : update;
	const server = useServerFieldErrors();

	const form = useForm({
		defaultValues: defaultsFor(line),
		validators: { onSubmit: sharedLineFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = sharedLineFormSchema.parse(value);
			server.clear();

			/**
			 * Three `null`s that mean different things, and each difference is the column's rather than
			 * this form's. `extensionNumber` is genuinely nullable, so `null` CLEARS it — a line reached
			 * only through its member buttons has no number. `ringTimeoutSeconds` is
			 * `notNull().default(30)` and `resettable`, so `null` puts the server default back. So is
			 * `holdRecallTimeoutSeconds` when the box is emptied — but `0` is a value it keeps, meaning
			 * "never recall", which the schema preserves rather than folding into the blank.
			 */
			const body = {
				name: parsed.name,
				extensionNumber: parsed.extensionNumber,
				strategy: parsed.strategy,
				ringTimeoutSeconds: parsed.ringTimeoutSeconds,
				holdRecallTimeoutSeconds: parsed.holdRecallTimeoutSeconds,
				bargeInEnabled: parsed.bargeInEnabled,
				enabled: parsed.enabled,
			};

			try {
				if (line === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: line.id, values: body });
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
			title={line === null ? "New shared line" : `Edit ${line.name}`}
			description="One line on several handsets, seized as one. How it offers itself, and how it recalls a call left on hold."
			submitLabel={line === null ? "Create shared line" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			footerNote={
				line === null
					? "Appearances are added on the line's page once it exists. A line with no appearances lights nobody's button."
					: undefined
			}
		>
			<FormSection title="Line">
				<form.Field name="name">
					{(field) => (
						<TextField
							field={field}
							label="Name"
							required
							autoFocus={line === null}
							placeholder="Front desk"
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
							placeholder="8500"
							description="Optional. Left empty, the line has no number of its own and is reachable only through its member buttons — which is a complete way to reach it, so there is no need to invent digits that might collide with an extension."
							disabled={mutation.isPending}
							submitError={server.errors.extensionNumber}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>
				<form.Field name="strategy">
					{(field) => (
						<SelectField
							field={field}
							label="Offer the call"
							description="How a call to the line's number reaches its appearances. All at once is the receptionist case; in order walks them by button position — the boss, then the assistant."
							disabled={mutation.isPending}
							submitError={server.errors.strategy}
							className="sm:col-span-2"
						>
							{SHARED_LINE_STRATEGIES.map((value) => (
								<option key={value} value={value}>
									{STRATEGY_LABELS[value]}
								</option>
							))}
						</SelectField>
					)}
				</form.Field>
				<form.Field name="ringTimeoutSeconds">
					{(field) => (
						<TextField
							field={field}
							label="Ring each appearance (seconds)"
							placeholder="30"
							description="How long each appearance is rung before the offer moves on. Blank keeps the system default."
							disabled={mutation.isPending}
							submitError={server.errors.ringTimeoutSeconds}
						/>
					)}
				</form.Field>
				<form.Field name="holdRecallTimeoutSeconds">
					{(field) => (
						<TextField
							field={field}
							label="Recall a held call (seconds)"
							placeholder="60"
							description="How long a call left on hold may sit before it rings every appearance back, so a held caller is not forgotten. 0 disables recall — the line holds indefinitely. Blank keeps the system default."
							disabled={mutation.isPending}
							submitError={server.errors.holdRecallTimeoutSeconds}
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="Behaviour" columns={1}>
				<form.Field name="bargeInEnabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Allow barge-in"
							description="When on, an idle appearance may join a call already up on the line — the boss/admin barge. Note that the flag is stored and compiled, but the live media join awaits the media plane, so turning this on records the intent without a call joining on it yet."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
				<form.Field name="enabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Enabled"
							description="A disabled line lights no buttons, and anything pointed at it takes no effect."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
