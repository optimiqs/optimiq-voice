"use client";

import { useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import type { ProvisioningTokenResult } from "~/lib/provisioning/contracts";

/**
 * The provisioning URL, shown once.
 *
 * ## Why "once" is not a UI preference
 *
 * The URL contains the secret half of a token that is stored only as a SHA-256. It exists in
 * exactly one HTTP response — the create or the rotate that minted it — and there is no endpoint,
 * anywhere, that can produce it again. So this panel is not hiding something it could reveal; it is
 * the only place the value ever existed, and closing the dialog is genuinely irreversible.
 *
 * That is the same trade the trunk provisioning panel makes for a SIP password, and it is made for
 * the same reason: a credential that can be re-read from the database is a credential in the
 * database.
 *
 * ## Why it is not a QR code yet
 *
 * A QR would be the right control for a softphone — the payload URL is exactly what Zoiper and
 * Linphone expect to scan — and rendering one needs an encoder this repository does not have. Rather
 * than add a dependency for a decoration, the URL is presented as large, selectable, monospaced text
 * with a copy button, which is what an administrator standing at a desk actually uses. The QR is
 * recorded as a follow-up in the report accompanying this change.
 */
export function ProvisioningUrlPanel({
	provisioning,
	onDismiss,
}: {
	provisioning: ProvisioningTokenResult;
	onDismiss?: () => void;
}) {
	const [copied, setCopied] = useState(false);
	const url = provisioning.configUrl;

	return (
		<section
			aria-label="New provisioning URL"
			className="flex flex-col gap-3 rounded-panel border border-warning/40 bg-warning-subtle px-4 py-3"
		>
			<div className="flex flex-wrap items-center gap-2">
				<Badge tone="warning">Shown once</Badge>
				{provisioning.expiresAt ? (
					<Badge tone="neutral">
						Expires {new Date(provisioning.expiresAt).toLocaleDateString()}
					</Badge>
				) : null}
			</div>

			<p className="text-sm text-foreground">
				This URL is not stored and will not be shown again. Enter it in the phone&rsquo;s
				provisioning server field, or serve it through DHCP option 66. Rotating generates a new one
				and stops this one working immediately.
			</p>

			{url === null ? (
				<p className="text-sm text-foreground">
					The deployment has no <code className="font-mono text-xs">PROVISION_BASE_URL</code>, so
					the full URL cannot be built here. The token is{" "}
					<code className="font-mono text-xs break-all">{provisioning.token}</code> — append it to
					your API&rsquo;s public origin as{" "}
					<code className="font-mono text-xs">/provision/&lt;token&gt;/config</code>.
				</p>
			) : (
				<div className="flex flex-col gap-2">
					<code
						// `select-all` so one click selects the whole URL: an administrator reading it onto a
						// handset keypad needs the entire string, and a double-click would stop at a hyphen.
						className="block rounded-panel border border-border bg-surface px-3 py-2 font-mono text-xs break-all select-all"
						data-testid="provisioning-url"
					>
						{url}
					</code>
					<div className="flex flex-wrap items-center gap-2">
						<Button
							size="sm"
							variant="secondary"
							onClick={() => {
								void navigator.clipboard?.writeText(url).then(() => {
									setCopied(true);
									// Reverts on its own: a button stuck on "Copied" is a button that lies the
									// second time it is used.
									setTimeout(() => setCopied(false), 2000);
								});
							}}
						>
							{copied ? "Copied" : "Copy URL"}
						</Button>
						{onDismiss ? (
							<Button size="sm" variant="ghost" onClick={onDismiss}>
								I have saved it
							</Button>
						) : null}
					</div>
				</div>
			)}
		</section>
	);
}
