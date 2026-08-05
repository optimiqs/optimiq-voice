"use client";

import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { z } from "zod";
import { ConfirmDialog } from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { EmptyState } from "~/components/ui/empty-state";
import { SelectField, TextField } from "~/components/ui/form-fields";
import { FormFooter } from "~/components/ui/form-footer";
import { KeyIcon } from "~/components/ui/icons";
import { PageHeader } from "~/components/ui/page-header";
import { LoadingPanel } from "~/components/ui/spinner";
import {
	Table,
	TableBody,
	TableCell,
	TableContainer,
	TableHead,
	TableHeader,
	TableRow,
} from "~/components/ui/table";
import { toast } from "~/components/ui/toast";
import { useAppSession, usePermission } from "../../_context/session-context";
import { useApiKeys, useCreateApiKey, useRevokeApiKey } from "../../_hooks/use-api-key-queries";
import { SettingsNav } from "../_components/settings-nav";

const EXPIRY_CHOICES = ["30", "90", "365", "never"] as const;

const createApiKeySchema = z.strictObject({
	name: z.string().trim().min(2, "Give the key a name you will recognize later"),
	expiry: z.enum(EXPIRY_CHOICES),
});

const defaultCreateApiKeyValues: z.input<typeof createApiKeySchema> = {
	name: "",
	expiry: "90",
};

function formatDate(value: Date | string | null): string {
	if (!value) {
		return "—";
	}
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime())
		? "—"
		: date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function ApiKeysPage() {
	const session = useAppSession();
	const organizationId = session.activeOrganization?.id;

	const keys = useApiKeys(organizationId);
	const createKey = useCreateApiKey(organizationId);
	const revokeKey = useRevokeApiKey(organizationId);

	const canWrite = usePermission("api-keys.write");
	const canRevoke = usePermission("api-keys.revoke");

	const [createOpen, setCreateOpen] = useState(false);
	const [issuedKey, setIssuedKey] = useState<string | null>(null);
	const [pendingRevoke, setPendingRevoke] = useState<{ id: string; name: string } | null>(null);

	const form = useForm({
		defaultValues: defaultCreateApiKeyValues,
		validators: { onChange: createApiKeySchema, onSubmit: createApiKeySchema },
		onSubmit: async ({ value }) => {
			const parsed = createApiKeySchema.parse(value);
			const created = await createKey.mutateAsync({
				name: parsed.name,
				expiresInDays: parsed.expiry === "never" ? null : Number(parsed.expiry),
			});
			form.reset();
			setCreateOpen(false);
			// The plaintext key exists in this response and nowhere else, ever again.
			setIssuedKey(created.key);
		},
	});

	return (
		<>
			<PageHeader
				title="API keys"
				description="Programmatic credentials for this organization. Keys belong to the organization, not to the person who created them."
				actions={
					canWrite ? (
						<Button variant="primary" onClick={() => setCreateOpen(true)}>
							Create key
						</Button>
					) : null
				}
			/>
			<SettingsNav />

			<Card>
				<CardHeader>
					<CardTitle>Active keys</CardTitle>
					<CardDescription>
						Only the first few characters of a key are stored in readable form. Revoking is
						immediate and cannot be undone.
					</CardDescription>
				</CardHeader>
				<CardBody className="p-0">
					{keys.isPending ? (
						<LoadingPanel label="Loading API keys" />
					) : keys.data && keys.data.length > 0 ? (
						<TableContainer className="rounded-none border-0">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Name</TableHead>
										<TableHead>Key</TableHead>
										<TableHead>Created</TableHead>
										<TableHead>Expires</TableHead>
										<TableHead>Last used</TableHead>
										<TableHead className="w-0" />
									</TableRow>
								</TableHeader>
								<TableBody>
									{keys.data.map((key) => (
										<TableRow key={key.id}>
											<TableCell className="font-medium">{key.name ?? "Unnamed key"}</TableCell>
											<TableCell>
												<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
													{key.start ?? key.prefix ?? "ovk_"}…
												</code>
											</TableCell>
											<TableCell className="text-muted-foreground">
												{formatDate(key.createdAt)}
											</TableCell>
											<TableCell className="text-muted-foreground">
												{key.expiresAt ? formatDate(key.expiresAt) : "Never"}
											</TableCell>
											<TableCell className="text-muted-foreground">
												{key.lastRequest ? formatDate(key.lastRequest) : "Never used"}
											</TableCell>
											<TableCell className="text-right">
												{key.enabled ? null : <Badge tone="warning">Disabled</Badge>}
												{canRevoke ? (
													<Button
														size="sm"
														variant="ghost"
														onClick={() =>
															setPendingRevoke({ id: key.id, name: key.name ?? "this key" })
														}
													>
														Revoke
													</Button>
												) : null}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</TableContainer>
					) : (
						<EmptyState
							className="rounded-none border-0"
							icon={<KeyIcon className="size-5" />}
							title="No API keys"
							description="Create a key to let a script, an integration or a CI job call the Optimiq Voice API on this organization's behalf."
							action={
								canWrite ? (
									<Button variant="primary" onClick={() => setCreateOpen(true)}>
										Create key
									</Button>
								) : null
							}
						/>
					)}
				</CardBody>
			</Card>

			<Dialog open={createOpen} onOpenChange={setCreateOpen}>
				<DialogContent>
					<form
						noValidate
						onSubmit={(event) => {
							event.preventDefault();
							void form.handleSubmit();
						}}
					>
						<DialogHeader>
							<DialogTitle>Create an API key</DialogTitle>
							<DialogDescription>
								The key is shown once, immediately after it is created, and is never retrievable
								again.
							</DialogDescription>
						</DialogHeader>

						<div className="flex flex-col gap-4">
							<form.Field name="name">
								{(field) => (
									<TextField
										field={field}
										label="Name"
										placeholder="Billing sync"
										required
										autoFocus
										disabled={createKey.isPending}
										description="Names appear in audit entries — describe what uses the key."
									/>
								)}
							</form.Field>

							<form.Field name="expiry">
								{(field) => (
									<SelectField
										field={field}
										label="Expires"
										disabled={createKey.isPending}
										description="A key that never expires is a key nobody remembers to rotate."
									>
										<option value="30">In 30 days</option>
										<option value="90">In 90 days</option>
										<option value="365">In a year</option>
										<option value="never">Never</option>
									</SelectField>
								)}
							</form.Field>
						</div>

						<DialogFooter>
							<FormFooter
								onCancel={() => setCreateOpen(false)}
								submitLabel="Create key"
								loadingLabel="Creating"
								loading={createKey.isPending}
							/>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>

			<Dialog
				open={issuedKey !== null}
				onOpenChange={(open) => {
					if (!open) {
						setIssuedKey(null);
					}
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Copy your API key now</DialogTitle>
						<DialogDescription>
							This is the only time it will be shown. Store it in a secret manager — not in source
							control.
						</DialogDescription>
					</DialogHeader>
					<code className="block w-full overflow-x-auto rounded-field bg-muted px-3 py-2 font-mono text-xs break-all text-foreground">
						{issuedKey}
					</code>
					<DialogFooter>
						<Button
							variant="secondary"
							onClick={() => {
								if (issuedKey) {
									void navigator.clipboard
										.writeText(issuedKey)
										.then(() => toast.success("Copied to clipboard"))
										.catch(() => toast.error("Could not copy. Select the key and copy it."));
								}
							}}
						>
							Copy key
						</Button>
						<Button variant="primary" onClick={() => setIssuedKey(null)}>
							I have saved it
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<ConfirmDialog
				open={pendingRevoke !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingRevoke(null);
					}
				}}
				title={`Revoke ${pendingRevoke?.name ?? "this key"}?`}
				description="Anything using this key stops working immediately. This cannot be undone."
				confirmLabel="Revoke key"
				destructive
				pending={revokeKey.isPending}
				onConfirm={() => {
					if (pendingRevoke) {
						revokeKey.mutate(pendingRevoke.id, { onSettled: () => setPendingRevoke(null) });
					}
				}}
			/>
		</>
	);
}
