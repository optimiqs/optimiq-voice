"use client";

import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { EntityFormDialog, FormSection } from "~/components/pbx/entity-form-dialog";
import { SwitchField, TextField, TextareaField } from "~/components/ui/form-fields";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { webhookFormSchema, type WebhookFormValues } from "~/lib/pbx/schemas";
import {
	buildSelectors,
	parseSelectorInput,
	selectorListIssue,
	splitSelectors,
} from "~/lib/pbx/webhook-selectors";
import { usePbxCreate, usePbxUpdate } from "../../_hooks/use-pbx-queries";
import { WebhookSelectorField } from "./webhook-selector-field";
import type { WebhookFamily, WebhookRow } from "~/lib/pbx/contracts";

/**
 * One outbound webhook subscription.
 *
 * ## Blank `secret` means two different things, and both are correct
 *
 * On CREATE it means "generate one": the server mints 256 bits and returns the value exactly once,
 * in the create response and nowhere else. This dialog hands that value straight to
 * `onSecretIssued` and keeps no copy — the screen shows it in the one dialog that renders a
 * credential, and it is unrecoverable after that.
 *
 * On EDIT it means "leave the existing key alone". The secret is never returned by a read, so the
 * field cannot be pre-filled, and a form that sent an empty string would rotate a working signature
 * to nothing. The key is omitted from the PATCH body entirely, which is what `PATCH` semantics turn
 * into "unchanged".
 *
 * ## `url` is checked for shape here and for scheme on the server
 *
 * The client mirrors the DTO exactly: an absolute http(s) URL carrying no embedded credentials. The
 * `https`-ONLY rule lives one layer up in `WebhooksService`, because it depends on
 * `PBX_WEBHOOK_ALLOW_INSECURE_URLS` — an environment variable this bundle cannot read. Refusing
 * `http` here would break the development deployments that variable exists for; a deployment that
 * enforces it answers with a 400 addressed at `url`, which lands on this control through
 * `pbxFieldErrors`. The field says so rather than guessing.
 *
 * Nothing checks that the host resolves or that it is not a private address. That is the server's
 * reasoning and it is worth repeating: DNS is not stable between a write-time check and the
 * delivery, so the control that works belongs in the dispatcher — a fixed method, no redirects, a
 * short timeout — and it is implemented there rather than pretended at here.
 *
 * ## Turning it back on is a recovery, not just a switch
 *
 * `PATCH { enabled: true }` clears the consecutive-failure counter and `auto_disabled_at` on the
 * server. Without that, re-enabling an auto-disabled subscription would arm the auto-disable at the
 * first hiccup after the fix, because the counter would still be at its ceiling. The switch's
 * description says what saving will do, because "it disabled itself again immediately" is otherwise
 * an unpleasant surprise.
 */
interface SelectorState {
	readonly families: readonly WebhookFamily[];
	readonly typesText: string;
	readonly unknown: readonly string[];
}

function defaultsFor(webhook: WebhookRow | null): WebhookFormValues {
	return {
		description: webhook?.description ?? "",
		url: webhook?.url ?? "",
		// Never pre-filled: a read does not return it, and a blank field is what "unchanged" looks
		// like on edit and "generate one" looks like on create.
		secret: "",
		enabled: webhook?.enabled ?? true,
	};
}

function selectorsFor(webhook: WebhookRow | null): SelectorState {
	const split = splitSelectors(webhook?.eventSelectors ?? []);
	return {
		families: split.families,
		// The unknown entries are put back into the textarea with the exact types, so the form cannot
		// silently drop a filter that is currently in force.
		typesText: [...split.types, ...split.unknown].join("\n"),
		unknown: split.unknown,
	};
}

export function WebhookDialog({
	open,
	onOpenChange,
	webhook,
	onSecretIssued,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	webhook: WebhookRow | null;
	/** Called with the generated key, once, straight out of the create response. */
	onSecretIssued: (secret: string) => void;
}) {
	const create = usePbxCreate(PBX_RESOURCES.webhooks);
	const update = usePbxUpdate(PBX_RESOURCES.webhooks);
	const mutation = webhook === null ? create : update;
	const server = useServerFieldErrors();

	const initialSelectors = selectorsFor(webhook);
	const [selectors, setSelectors] = useState<SelectorState>(initialSelectors);
	const [localErrors, setLocalErrors] = useState<Readonly<Record<string, string>>>({});

	const form = useForm({
		defaultValues: defaultsFor(webhook),
		validators: { onSubmit: webhookFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = webhookFormSchema.parse(value);
			server.clear();

			const eventSelectors = buildSelectors(
				selectors.families,
				parseSelectorInput(selectors.typesText),
			);
			const problem = selectorListIssue(eventSelectors);
			if (problem !== undefined) {
				setLocalErrors({ eventSelectors: problem });
				return;
			}
			setLocalErrors({});

			try {
				if (webhook === null) {
					const created = await create.mutateAsync({
						description: parsed.description,
						url: parsed.url,
						// Omitted when blank, which is what the server reads as "generate one".
						...(parsed.secret === null ? {} : { secret: parsed.secret }),
						eventSelectors: [...eventSelectors],
						enabled: parsed.enabled,
					});
					// The one response in the whole API that carries a secret column. If it is missing the
					// dialog simply closes: the subscription was created either way, and inventing a
					// "could not read your key" error for a field that is not part of the contract on
					// every other path would be worse than saying nothing.
					if (created.data.secret !== undefined) {
						onSecretIssued(created.data.secret);
					}
				} else {
					await update.mutateAsync({
						id: webhook.id,
						values: {
							description: parsed.description,
							url: parsed.url,
							// Absent means unchanged. Sending `null` would clear a working signature.
							...(parsed.secret === null ? {} : { secret: parsed.secret }),
							eventSelectors: [...eventSelectors],
							enabled: parsed.enabled,
						},
					});
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
					setSelectors(initialSelectors);
					form.reset();
				}
				onOpenChange(next);
			}}
			title={webhook === null ? "New webhook" : `Edit ${webhook.description ?? webhook.url}`}
			description="Where deliveries go, which events they carry, and the key the receiving end verifies them with."
			submitLabel={webhook === null ? "Create webhook" : "Save changes"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => void form.handleSubmit()}
			size="lg"
			footerNote="Every delivery is signed with this subscription's key. A selector filters on what happened, never on whose — the events an endpoint receives are always this organization's."
		>
			<FormSection title="Endpoint" columns={1}>
				<form.Field name="url">
					{(field) => (
						<TextField
							field={field}
							label="URL"
							type="url"
							required
							autoFocus={webhook === null}
							placeholder="https://example.com/hooks/optimiq"
							description="An absolute http(s) URL with no username or password in it. Most deployments accept https only; a plain http endpoint is refused there with a message on this field."
							disabled={mutation.isPending}
							submitError={errors.url}
						/>
					)}
				</form.Field>
				<form.Field name="description">
					{(field) => (
						<TextareaField
							field={field}
							label="Description"
							rows={2}
							placeholder="Screen-pop for the CRM."
							description="What this endpoint is for. It is what the list shows instead of the URL."
							disabled={mutation.isPending}
							submitError={errors.description}
						/>
					)}
				</form.Field>
			</FormSection>

			<WebhookSelectorField
				families={selectors.families}
				onFamiliesChange={(families) => {
					setSelectors((current) => ({ ...current, families }));
					setLocalErrors({});
				}}
				typesText={selectors.typesText}
				onTypesTextChange={(typesText) => {
					setSelectors((current) => ({ ...current, typesText }));
					setLocalErrors({});
				}}
				unknown={selectors.unknown}
				disabled={mutation.isPending}
				error={errors.eventSelectors}
			/>

			<FormSection title="Signing key" columns={1}>
				<form.Field name="secret">
					{(field) => (
						<TextField
							field={field}
							label={webhook === null ? "Signing key" : "Replace the signing key"}
							type="password"
							autoComplete="off"
							placeholder={
								webhook === null
									? "Leave blank to generate one"
									: "Leave blank to keep the current key"
							}
							description={
								webhook === null
									? "Between 16 and 256 characters. Leave it blank and we will generate one and show it to you once — it is never retrievable afterwards."
									: "The current key cannot be shown, only replaced. Type a new one to rotate it, which stops the far end verifying deliveries until it has the new value too."
							}
							disabled={mutation.isPending}
							submitError={errors.secret}
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
							description={
								webhook?.autoDisabledAt
									? "This endpoint was switched off by the platform after consecutive failures. Turning it back on also clears the failure counter, so a single bad delivery will not immediately disable it again."
									: "A disabled subscription receives nothing. It keeps its signing key and its selectors, so switching it back on resumes deliveries unchanged."
							}
							disabled={mutation.isPending}
						/>
					)}
				</form.Field>
			</FormSection>
		</EntityFormDialog>
	);
}
