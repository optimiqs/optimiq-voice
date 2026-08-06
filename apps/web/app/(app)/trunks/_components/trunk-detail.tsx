"use client";

import Link from "next/link";
import { useState } from "react";
import { EnabledBadge } from "~/components/pbx/resource-list";
import { NoticeBanner } from "~/components/pbx/warnings-banner";
import { ConfirmDialog } from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { EmptyState } from "~/components/ui/empty-state";
import { PageHeader } from "~/components/ui/page-header";
import { LoadingPanel } from "~/components/ui/spinner";
import { ApiError } from "~/lib/api-client";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { routes } from "~/lib/routes";
import { usePermission } from "../../_context/session-context";
import { useCarrierStatus, useProvisionTrunk } from "../../_hooks/use-carrier-queries";
import { usePbxItem } from "../../_hooks/use-pbx-queries";
import { TrunkDialog } from "./trunk-dialog";
import type { TrunkCredentials } from "~/lib/carrier/client";
import type { TrunkRow } from "~/lib/pbx/contracts";

/**
 * One trunk, and the button that makes it work.
 *
 * ## Why this page exists at all
 *
 * Every other flat resource in this app is edited in a dialog over its list, and for good reason.
 * This one has a route because provisioning returns a SIP password that is shown ONCE and is the
 * kind of thing an admin copies into a phone system while reading it off the screen — and a dialog
 * is dismissed by a click anywhere outside it. Losing the password to a stray click is recoverable
 * (re-provision rotates it) but it invalidates the registration that was just set up, which is a
 * bad way to learn how the feature works.
 */
export function TrunkDetail({ trunkId }: { trunkId: string }) {
	const trunk = usePbxItem(PBX_RESOURCES.trunks, trunkId);
	const canWrite = usePermission(PBX_RESOURCES.trunks.permissions.write);
	const [editOpen, setEditOpen] = useState(false);

	if (trunk.isPending) {
		return <LoadingPanel label="Loading trunk" />;
	}

	if (trunk.error instanceof ApiError && trunk.error.status === 404) {
		return (
			<EmptyState
				title="This trunk no longer exists"
				description="It may have been deleted from another session."
				action={
					<Button render={<Link href={routes.trunks} />} variant="secondary">
						Back to trunks
					</Button>
				}
			/>
		);
	}

	if (!trunk.data) {
		return (
			<EmptyState
				title="Could not load this trunk"
				description={trunk.error instanceof Error ? trunk.error.message : "Try again in a moment."}
			/>
		);
	}

	const row = trunk.data as TrunkRow;

	return (
		<>
			<PageHeader
				title={row.name}
				description={`${row.kind === "register" ? "Registers to" : "Sends to"} ${row.sipProxy} as ${row.authUser ?? "an unauthenticated peer"}.`}
				actions={
					<div className="flex items-center gap-2">
						<Button render={<Link href={routes.trunks} />} variant="secondary">
							Back
						</Button>
						{canWrite ? (
							<Button variant="secondary" onClick={() => setEditOpen(true)}>
								Edit
							</Button>
						) : null}
					</div>
				}
			/>

			<div className="flex flex-col gap-4">
				<Card>
					<CardHeader>
						<CardTitle>Connection</CardTitle>
						<CardDescription>
							What the SIP edge uses to reach this carrier, and what the carrier sees.
						</CardDescription>
					</CardHeader>
					<CardBody>
						<dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
							<Detail label="SIP domain" value={row.sipDomain} mono />
							<Detail label="Proxy" value={row.sipProxy} mono />
							<Detail label="Auth user" value={row.authUser ?? "—"} mono />
							<Detail label="Transport" value={row.transport.toUpperCase()} />
							<Detail
								label="Registration"
								value={
									row.kind === "register"
										? `Every ${row.registerExpiresSeconds}s`
										: "IP authenticated"
								}
							/>
							<Detail label="Channel cap" value={row.maxChannels?.toString() ?? "Unlimited"} />
							<Detail
								label="Provider"
								value={
									row.carrierProvider === null ? (
										<Badge tone="neutral">Bring your own SIP</Badge>
									) : (
										<Badge tone="accent">Managed · {row.carrierProvider}</Badge>
									)
								}
							/>
							<Detail label="State" value={<EnabledBadge enabled={row.enabled} />} />
						</dl>
					</CardBody>
				</Card>

				<TelnyxProvisioningCard trunk={row} />
			</div>

			<TrunkDialog key={row.id} open={editOpen} onOpenChange={setEditOpen} trunk={row} />
		</>
	);
}

function Detail({
	label,
	value,
	mono = false,
}: {
	label: string;
	value: React.ReactNode;
	mono?: boolean;
}) {
	return (
		<div className="flex flex-col gap-0.5">
			<dt className="text-xs font-medium text-muted-foreground">{label}</dt>
			<dd className={mono ? "font-mono text-sm text-foreground" : "text-sm text-foreground"}>
				{value}
			</dd>
		</div>
	);
}

/**
 * The provisioning panel.
 *
 * ## Three states, and each says something different
 *
 * **No carrier on the deployment** — nothing an admin of this organization can do, so it says what
 * an *operator* has to set rather than offering a button that would 503.
 *
 * **Not provisioned** — the button, plus what it will do, because it creates real resources on a
 * real account and the person clicking it should know that before they do.
 *
 * **Provisioned** — the connection's identifiers, and a re-provision that is explicitly framed as a
 * password rotation. Re-provisioning is safe (it updates the same connection rather than creating a
 * second one) but it invalidates the credential the endpoint is currently registered with, so the
 * confirmation says so.
 */
function TelnyxProvisioningCard({ trunk }: { trunk: TrunkRow }) {
	const status = useCarrierStatus();
	const canProvision = usePermission("trunks.write");
	const provision = useProvisionTrunk(trunk.id);
	const [confirming, setConfirming] = useState(false);
	const [credentials, setCredentials] = useState<TrunkCredentials | null>(null);

	const provisioned = trunk.carrierProvider !== null && trunk.carrierRef !== null;

	if (status.isPending) {
		return null;
	}

	if (status.data?.configured !== true) {
		return (
			<NoticeBanner
				title="No carrier connected"
				description={
					<>
						This deployment has no carrier configured, so a trunk cannot be provisioned
						automatically. An operator needs to set{" "}
						<code className="font-mono text-xs">TELNYX_API_KEY</code> on the API. A trunk whose SIP
						details you enter by hand keeps working exactly as before.
					</>
				}
			/>
		);
	}

	return (
		<>
			<Card>
				<CardHeader>
					<CardTitle>Carrier provisioning</CardTitle>
					<CardDescription>
						{provisioned
							? "This trunk is provisioned with Telnyx. The SIP credentials below are what the edge registers with."
							: `Create a SIP connection on Telnyx for this trunk and fill in its details automatically — no manual SIP configuration, and outbound routes over it start working as soon as it registers to ${status.data.sipDomain}.`}
					</CardDescription>
				</CardHeader>
				<CardBody className="flex flex-col gap-4">
					{provisioned ? (
						<dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
							<Detail label="Registrar" value={trunk.sipDomain} mono />
							<Detail label="SIP username" value={trunk.authUser ?? "—"} mono />
							<Detail label="Connection" value={trunk.carrierRef ?? "—"} mono />
							<Detail label="Outbound profile" value={trunk.carrierProfileRef ?? "—"} mono />
						</dl>
					) : null}

					{credentials === null ? null : (
						<section
							aria-label="New SIP credentials"
							className="flex flex-col gap-2 rounded-panel border border-warning/40 bg-warning-subtle px-4 py-3"
						>
							<div className="flex flex-wrap items-center gap-2">
								<Badge tone="warning">Shown once</Badge>
							</div>
							<p className="text-sm text-foreground">
								This password is not stored here and will not be shown again. Copy it into the SIP
								endpoint now — re-provisioning generates a new one and invalidates this.
							</p>
							<dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
								<Detail label="SIP URI" value={credentials.sipUri} mono />
								<Detail label="Username" value={credentials.sipUsername} mono />
								<Detail label="Password" value={credentials.sipPassword} mono />
								<Detail label="Register every" value={`${credentials.registerExpiresSeconds}s`} />
							</dl>
						</section>
					)}

					{canProvision ? (
						<div>
							<Button
								variant={provisioned ? "secondary" : "primary"}
								loading={provision.isPending}
								onClick={() => setConfirming(true)}
							>
								{provisioned ? "Re-provision and rotate password" : "Provision with Telnyx"}
							</Button>
						</div>
					) : (
						<NoticeBanner
							title="Read only"
							description="Provisioning changes how this organization reaches the PSTN and needs the “Manage trunks” permission."
						/>
					)}
				</CardBody>
			</Card>

			<ConfirmDialog
				open={confirming}
				onOpenChange={setConfirming}
				title={provisioned ? "Rotate this trunk's credentials?" : "Provision this trunk?"}
				description={
					provisioned
						? "A new SIP password is generated and the old one stops working. The endpoint will keep receiving calls until its current registration expires, then go quiet until you update it."
						: `A SIP connection and an outbound calling profile are created on the carrier account for this trunk, with a daily spend cap. The trunk's SIP details are overwritten with the carrier's.`
				}
				confirmLabel={provisioned ? "Rotate" : "Provision"}
				pending={provision.isPending}
				onConfirm={() => {
					provision.mutate(
						{},
						{
							onSuccess: (result) => {
								setCredentials(result.carrier);
								setConfirming(false);
							},
						},
					);
				}}
			/>
		</>
	);
}
