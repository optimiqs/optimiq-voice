"use client";

import { useForm } from "@tanstack/react-form";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { SelectField, SwitchField, TextField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { callBlockRuleFormSchema, type CallBlockRuleFormValues } from "~/lib/pbx/schemas";
import { usePbxCreate, usePbxUpdate } from "../../_hooks/use-pbx-queries";
import type { CallBlockAction, CallBlockMatchKind, CallBlockRuleRow } from "~/lib/pbx/contracts";

/**
 * Create and edit a screening rule.
 *
 * ## The pattern box has no client-side syntax check, and that is deliberate
 *
 * `compilePattern` in the routing package is what decides whether a rule can be enforced, and it
 * runs inside the server's write transaction: an uncompilable expression comes back as a 422
 * addressed at `pattern` and the row is rolled back, and an unanchored regex comes back as a
 * WARNING on a save that succeeded. Both land on this field through the ordinary error path. A
 * regex validator here would be a second opinion that refuses inputs the engine accepts, which is
 * the worse failure: a rule the platform would have enforced and the form would not let anybody
 * save.
 *
 * ## Why the description under `matchKind` changes with the selection
 *
 * The three kinds read the same box completely differently — `+1212` is one number, six thousand
 * numbers, or a literal string depending on which is selected — and getting it wrong is silent in
 * both directions. A prefix typed as an exact match screens nothing; an exact number typed as a
 * prefix screens every number that starts with it, which on a short pattern is most of a country.
 *
 * ## `allow` is the one that gets a warning
 *
 * Blocking a number is what somebody came here to do. Allowing one is the entry that lifts a
 * caller OUT of a broader block, and it is the reason the API gives screening its own write grant,
 * so the form says what it does rather than presenting four equivalent options.
 */
function defaultsFor(rule: CallBlockRuleRow | null): CallBlockRuleFormValues {
	return {
		pattern: rule?.pattern ?? "",
		/** The column's own `default("exact")` — the kind that screens exactly what was typed. */
		matchKind: rule?.matchKind ?? "exact",
		direction: rule?.direction ?? "inbound",
		action: rule?.action ?? "block",
		label: rule?.label ?? "",
		enabled: rule?.enabled ?? true,
	};
}

const PATTERN_HELP: Readonly<Record<CallBlockMatchKind, string>> = {
	exact:
		"The number as it arrives, in full — normally E.164, e.g. +12125550100. Nothing else matches.",
	prefix:
		"Every number that STARTS with what you type. +1212 screens the whole of that area code, so keep it as long as you mean it to be.",
	regex:
		"A regular expression, checked when you save. Anchor it (^…$) unless you mean it to match anywhere in the number — an unanchored expression is accepted with a warning, because it usually matches more than intended.",
};

const ACTION_HELP: Readonly<Record<CallBlockAction, string>> = {
	block: "The call is refused. This is what a blocklist entry normally means.",
	allow:
		"The call is let through even when a broader rule blocks it — an allow rule WINS over a block rule that matches just as specifically. Use it to make one number an exception to a blocked prefix, not as a way of un-blocking something (delete or disable the block rule for that).",
	reject: "The call is refused with a rejection cause rather than a plain hangup.",
	voicemail:
		"The caller goes to the mailbox of whoever they dialled. The rule cannot send them anywhere else — there is no destination to pick, on purpose.",
};

export function CallBlockRuleDialog({
	open,
	onOpenChange,
	rule,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	rule: CallBlockRuleRow | null;
}) {
	const create = usePbxCreate(PBX_RESOURCES.callBlockRules);
	const update = usePbxUpdate(PBX_RESOURCES.callBlockRules);
	const mutation = rule === null ? create : update;
	const server = useServerFieldErrors();

	const form = useForm({
		defaultValues: defaultsFor(rule),
		validators: { onSubmit: callBlockRuleFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = callBlockRuleFormSchema.parse(value);
			server.clear();

			/**
			 * `hitCount` and `lastHitAt` are absent and must stay absent: the server's `strictObject`
			 * answers a body carrying either with a 400 naming the field, so sending them "for
			 * completeness" would fail every save rather than being ignored.
			 */
			const body = {
				pattern: parsed.pattern,
				matchKind: parsed.matchKind,
				direction: parsed.direction,
				action: parsed.action,
				label: parsed.label,
				enabled: parsed.enabled,
			};

			try {
				if (rule === null) {
					await create.mutateAsync(body);
				} else {
					await update.mutateAsync({ id: rule.id, values: body });
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
			title={rule === null ? "New screening rule" : `Edit ${rule.pattern}`}
			description="Which number this rule reads, and what happens to a call that matches it."
			submitLabel={rule === null ? "Create rule" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			footerNote={
				rule === null
					? "Saving recompiles routing, so the next call is screened against this rule."
					: undefined
			}
		>
			<FormSection title="What it matches">
				<form.Subscribe selector={(state) => state.values.matchKind}>
					{(matchKind) => (
						<>
							<form.Field name="matchKind">
								{(field) => (
									<SelectField
										field={field}
										label="Read the number as"
										description={PATTERN_HELP[matchKind]}
										disabled={mutation.isPending}
										submitError={server.errors.matchKind}
									>
										<option value="exact">An exact number</option>
										<option value="prefix">A prefix</option>
										<option value="regex">A regular expression</option>
									</SelectField>
								)}
							</form.Field>
							<form.Field name="pattern">
								{(field) => (
									<TextField
										field={field}
										label="Number or pattern"
										required
										autoFocus={rule === null}
										placeholder={matchKind === "regex" ? "^\\+1212555\\d{4}$" : "+12125550100"}
										description="Checked when you save: an expression the router cannot compile is refused and nothing is stored."
										disabled={mutation.isPending}
										submitError={server.errors.pattern}
									/>
								)}
							</form.Field>
						</>
					)}
				</form.Subscribe>

				<form.Field name="direction">
					{(field) => (
						<SelectField
							field={field}
							label="Matched against"
							description="Inbound reads who is calling in; outbound reads what somebody here dialled. 'Either' is one rule that says 'we do not talk to this number at all' — it is a row of its own, not a shorthand for the other two."
							disabled={mutation.isPending}
							submitError={server.errors.direction}
							className="sm:col-span-2"
						>
							<option value="inbound">The caller&rsquo;s number (inbound)</option>
							<option value="outbound">The number dialled (outbound)</option>
							<option value="both">Either, in its own direction</option>
						</SelectField>
					)}
				</form.Field>
			</FormSection>

			<FormSection title="What happens">
				<form.Subscribe selector={(state) => state.values.action}>
					{(action) => (
						<form.Field name="action">
							{(field) => (
								<SelectField
									field={field}
									label="Then"
									description={ACTION_HELP[action]}
									disabled={mutation.isPending}
									submitError={server.errors.action}
									className="sm:col-span-2"
								>
									<option value="block">Block the call</option>
									<option value="reject">Reject the call</option>
									<option value="voicemail">Send to the callee&rsquo;s voicemail</option>
									<option value="allow">Allow the call through</option>
								</SelectField>
							)}
						</form.Field>
					)}
				</form.Subscribe>
				<form.Field name="label">
					{(field) => (
						<TextField
							field={field}
							label="Note"
							placeholder="Robocaller, reported 12 Aug"
							description="Optional, and for whoever reads this list in six months. The match counter says whether a rule is doing anything; this says why it was added."
							disabled={mutation.isPending}
							submitError={server.errors.label}
							className="sm:col-span-2"
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
							description="A disabled rule matches nothing, and keeps its match history. Switching a rule off is how you stop it applying without losing the record of what it caught — deleting it destroys that."
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>

			{rule === null ? null : (
				<p className="text-xs text-muted-foreground">
					{rule.hitCount === 0
						? "This rule has never matched a call."
						: `Matched ${rule.hitCount === 1 ? "one call" : `${rule.hitCount} calls`}${
								rule.lastHitAt === null
									? ""
									: `, most recently ${new Date(rule.lastHitAt).toLocaleString()}`
							}. Those counters are written by the platform and cannot be edited or reset here.`}
				</p>
			)}
		</EntityFormDialog>
	);
}
