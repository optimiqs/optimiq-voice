"use client";

import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { SelectField, SwitchField, TextField, TextareaField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { SIP_ACL_ACTIONS, SIP_ACL_SCOPES } from "~/lib/pbx/contracts";
import { sipAclEntryFormSchema } from "~/lib/pbx/schemas";
import { SIP_ACL_SCOPE_DESCRIPTIONS, SIP_ACL_SCOPE_LABELS } from "~/lib/pbx/security-labels";
import { usePbxCreate, usePbxUpdate } from "../../_hooks/use-pbx-queries";
import type { SipAclAction, SipAclEntryRow, SipAclScope } from "~/lib/pbx/contracts";

/**
 * One CIDR access rule.
 *
 * ## The scope has no default, and the empty option is the point
 *
 * Every other select in this app opens on something. This one opens on "Choose a scope", because
 * the column's own default is `registration` — the surface that decides whether phones can register
 * at all — and `sip-acl.dto.ts` refuses to apply that default to a body from a form for exactly
 * that reason: a caller who omitted the scope almost certainly did not mean it. A pre-selected
 * `registration` would make the most consequential choice the one you get by not choosing.
 *
 * That is also why the form state widens `scope` to `SipAclScope | ""` and the schema runs as a
 * `safeParse` inside `onSubmit` rather than as a submit validator — the same shape
 * `outbound-route-dialog.tsx` uses for `tollClass`, which is the other field in this app with no
 * safe default. A schema wired as the validator would have to be given an empty variant to type
 * against, which is precisely the value it exists to refuse.
 *
 * The description under the select changes with the selection, so the consequence is on screen at
 * the moment it is being decided rather than in a note somebody has already scrolled past.
 *
 * ## The network is validated twice on purpose
 *
 * `sipAclEntryFormSchema` runs `networkIssue` — the server's own pre-filter, mirrored — and then
 * NORMALISES a bare address to its `/32`. Both halves matter. Without the first, `10.0.0.1/24`
 * reaches a `cidr` column, comes back as a `22P02`, and renders as "the service is unavailable" to
 * somebody who mistyped a prefix. Without the second, `198.51.100.7` and `198.51.100.7/32` are two
 * spellings of one row that only collide on the unique index after PostgreSQL has widened them —
 * a 409 on a value this form believes it has never seen.
 *
 * A 409 is still reachable, legitimately: the index is `(organization_id, scope, network)`, so a
 * second rule for the same network in the same scope is refused and the existing entry is the one
 * to edit. `pbxFieldErrors` puts the server's message on the field it names.
 *
 * ## Why `action` is a select and not a switch
 *
 * "Allow" and "Deny" are not on and off — a disabled DENY is not an allow, it is no rule at all,
 * and the `enabled` switch below already means that. Two booleans reading as opposites would be the
 * fastest way to write a rule that does the reverse of what was intended.
 */
interface SipAclFormState {
	name: string;
	network: string;
	action: SipAclAction;
	/** Widened, because "no scope chosen yet" is a state the schema deliberately has no value for. */
	scope: SipAclScope | "";
	priority: string;
	description: string;
	enabled: boolean;
}

function defaultsFor(entry: SipAclEntryRow | null): SipAclFormState {
	return {
		name: entry?.name ?? "",
		network: entry?.network ?? "",
		action: entry?.action ?? "allow",
		scope: entry?.scope ?? "",
		priority: entry?.priority === undefined ? "" : String(entry.priority),
		description: entry?.description ?? "",
		enabled: entry?.enabled ?? true,
	};
}

export function SipAclEntryDialog({
	open,
	onOpenChange,
	entry,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	entry: SipAclEntryRow | null;
}) {
	const create = usePbxCreate(PBX_RESOURCES.sipAclEntries);
	const update = usePbxUpdate(PBX_RESOURCES.sipAclEntries);
	const mutation = entry === null ? create : update;
	const server = useServerFieldErrors();

	const [localErrors, setLocalErrors] = useState<Readonly<Record<string, string>>>({});

	const form = useForm({
		defaultValues: defaultsFor(entry),
		onSubmit: async ({ value }) => {
			server.clear();

			const parsed = sipAclEntryFormSchema.safeParse(value);
			if (!parsed.success) {
				const problems: Record<string, string> = {};
				for (const issue of parsed.error.issues) {
					problems[String(issue.path[0])] ??= issue.message;
				}
				setLocalErrors(problems);
				return;
			}
			setLocalErrors({});

			const body = {
				name: parsed.data.name,
				network: parsed.data.network,
				action: parsed.data.action,
				scope: parsed.data.scope,
				priority: parsed.data.priority ?? undefined,
				description: parsed.data.description,
				enabled: parsed.data.enabled,
			};

			try {
				if (entry === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: entry.id, values: body });
				}
				form.reset();
				onOpenChange(false);
			} catch (error) {
				server.capture(error);
			}
		},
	});

	const errors = { ...server.errors, ...localErrors };

	return (
		<EntityFormDialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					server.clear();
					mutation.reset();
					setLocalErrors({});
					form.reset();
				}
				onOpenChange(next);
			}}
			title={entry === null ? "New access rule" : `Edit ${entry.network}`}
			description="Which networks may reach one of this platform's SIP surfaces, and what happens when they do."
			submitLabel={entry === null ? "Create access rule" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			size="lg"
			footerNote="Registration and trunk rules are rendered into the media server's access configuration, so they take effect after a regenerate and a transport reload. Provisioning and API rules are read from the database and apply immediately."
		>
			<FormSection title="Rule">
				<form.Field name="network">
					{(field) => (
						<TextField
							field={field}
							label="Network"
							required
							autoFocus={entry === null}
							placeholder="203.0.113.0/24"
							description="A CIDR network, or a bare address for a single host. Write the network address: 10.0.0.1/24 is refused, 10.0.0.0/24 is what was meant."
							disabled={mutation.isPending}
							submitError={errors.network}
							className="sm:col-span-2"
						/>
					)}
				</form.Field>

				<form.Field name="action">
					{(field) => (
						<SelectField
							field={field}
							label="Action"
							required
							description="What happens to traffic that matches. A deny you switch off is not an allow — it is no rule at all."
							disabled={mutation.isPending}
							submitError={errors.action}
						>
							{SIP_ACL_ACTIONS.map((action) => (
								<option key={action} value={action}>
									{action === "allow" ? "Allow" : "Deny"}
								</option>
							))}
						</SelectField>
					)}
				</form.Field>

				<form.Field name="scope">
					{(field) => (
						<SelectField
							field={field}
							label="Scope"
							required
							description={
								field.state.value === ""
									? "Which surface this rule guards. There is no default: the same network in two scopes is two rules, and widening one from provisioning to trunk is a decision."
									: SIP_ACL_SCOPE_DESCRIPTIONS[field.state.value]
							}
							disabled={mutation.isPending}
							submitError={errors.scope}
						>
							<option value="" disabled>
								Choose which surface this guards…
							</option>
							{SIP_ACL_SCOPES.map((scope) => (
								<option key={scope} value={scope}>
									{SIP_ACL_SCOPE_LABELS[scope]}
								</option>
							))}
						</SelectField>
					)}
				</form.Field>

				<form.Field name="priority">
					{(field) => (
						<TextField
							field={field}
							label="Priority"
							placeholder="100"
							description="Lower wins. Ties are broken by the longer prefix. Leave it empty to take the default."
							disabled={mutation.isPending}
							submitError={errors.priority}
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="Description" columns={1}>
				<form.Field name="name">
					{(field) => (
						<TextField
							field={field}
							label="Name"
							placeholder="HQ office"
							description="What you will call this rule when you come back to it in a year."
							disabled={mutation.isPending}
							submitError={errors.name}
						/>
					)}
				</form.Field>
				<form.Field name="description">
					{(field) => (
						<TextareaField
							field={field}
							label="Note"
							rows={2}
							placeholder="Berlin office static range, confirmed with the ISP on 2026-03-04."
							description="Why this rule exists. The next person to read the allowlist is the audience."
							disabled={mutation.isPending}
							submitError={errors.description}
						/>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="State" columns={1}>
				<form.Field name="enabled">
					{(field) => (
						<SwitchField
							field={field}
							label="Enabled"
							description="A disabled rule is not evaluated at all, in either direction. Switching one off is the reversible way to test whether it is the rule causing a refusal."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
