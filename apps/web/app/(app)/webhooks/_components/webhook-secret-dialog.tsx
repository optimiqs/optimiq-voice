"use client";

import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { toast } from "~/components/ui/toast";

/**
 * The signing key, shown exactly once.
 *
 * `secret` is in the resource's `secretColumns`, so the generic redaction strips it from every list,
 * get and update body. `WebhooksService.create` re-attaches it to the create response — and only
 * that one — because a key nobody can read is a subscription nobody can verify. This dialog is the
 * one place in the app that renders the value, and it holds it in a single piece of component state
 * that is dropped the moment it is dismissed.
 *
 * A key that is not copied here is unrecoverable and has to be rotated, which is the correct trade:
 * the alternative is an endpoint that hands every tenant's signing key to anybody holding
 * `webhooks.read`. The copy says so plainly rather than letting somebody discover it later.
 *
 * The same shape as the API-key reveal on `/settings/api-keys`, deliberately: "we showed you a
 * credential once" is a moment a user should recognise from having seen it before, not a new
 * interaction to work out.
 */
export function WebhookSecretDialog({
	secret,
	onDismiss,
}: {
	secret: string | null;
	onDismiss: () => void;
}) {
	return (
		<Dialog
			open={secret !== null}
			onOpenChange={(open) => {
				if (!open) {
					onDismiss();
				}
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Copy your signing key now</DialogTitle>
					<DialogDescription>
						This is the only time it will be shown. The receiving end needs it to verify that a
						delivery came from us and was not altered — store it in a secret manager, not in source
						control. If you lose it you will have to set a new one, which invalidates the old.
					</DialogDescription>
				</DialogHeader>
				<code className="block w-full overflow-x-auto rounded-field bg-muted px-3 py-2 font-mono text-xs break-all text-foreground">
					{secret}
				</code>
				<DialogFooter>
					<Button
						variant="secondary"
						onClick={() => {
							if (secret) {
								void navigator.clipboard
									.writeText(secret)
									.then(() => toast.success("Copied to clipboard"))
									.catch(() => toast.error("Could not copy. Select the key and copy it."));
							}
						}}
					>
						Copy key
					</Button>
					<Button variant="primary" onClick={onDismiss}>
						I have saved it
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
