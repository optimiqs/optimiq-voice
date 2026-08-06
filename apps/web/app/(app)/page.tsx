"use client";

import Link from "next/link";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { PageHeader } from "~/components/ui/page-header";
import { canAccessPage } from "~/lib/page-permissions";
import { roleLabel } from "~/lib/permissions";
import { routes } from "~/lib/routes";
import { NAV_SECTIONS } from "./_components/nav-config";
import { useAppSession, useAnyPermission } from "./_context/session-context";
import { useLiveStatus } from "./_context/live-context";
import { LiveIndicator } from "./queues/_components/agent-console";
import {
	useLiveActiveCalls,
	useLiveAgentStates,
	useLiveRegistrations,
} from "./_hooks/use-live-queries";

/**
 * The landing surface: what is happening on this tenant's phone system, right now.
 *
 * ## Every number here comes from the socket, not from a poll
 *
 * Three KV buckets are the authority for live state — `registrations`, `channels`, `agent-state` —
 * and this page watches them through `/api/v1/live`. Nothing is fetched on an interval, so the
 * page costs one WebSocket rather than three requests every few seconds per open tab, and a change
 * appears when it happens rather than on the next tick.
 *
 * ## A tile the caller may not watch is not rendered
 *
 * Each topic is gated on the permission the server gates it on, and `useLive*` returns
 * `permitted: false` rather than an empty count when it is missing. That matters because "0
 * registered devices" and "you may not see registered devices" look identical as a number, and the
 * first is an incident.
 *
 * ## Not loaded is not zero
 *
 * A tile shows a dash until its snapshot arrives. A dashboard that painted `0 active calls`
 * half a second before the snapshot said `7` would be a number that was briefly, confidently
 * wrong — which on an operations screen is worse than a number that is briefly absent.
 */
export default function OverviewPage() {
	const session = useAppSession();
	const granted = new Set<string>(session.permissions);
	const organization = session.activeOrganization;
	const connection = useLiveStatus();

	const registrations = useLiveRegistrations();
	const calls = useLiveActiveCalls();
	const agents = useLiveAgentStates();

	const watchesAnything = useAnyPermission(["extensions.read", "cdr.read", "queues.monitor"]);

	const reachable = NAV_SECTIONS.flatMap((section) => section.items).filter(
		(item) => item.url !== routes.overview && canAccessPage(item.url, granted),
	);

	return (
		<>
			<PageHeader
				title={organization ? organization.name : "Dashboard"}
				description="Live registration, call and queue activity, streamed from the switch as it happens."
				actions={
					<div className="flex items-center gap-2">
						{watchesAnything ? <LiveIndicator /> : null}
						<Button variant="secondary" render={<Link href={routes.settings} />}>
							Organization settings
						</Button>
					</div>
				}
			/>

			{watchesAnything ? (
				<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
					<LiveTile
						label="Registered devices"
						value={registrations.loaded ? String(registrations.liveCount) : null}
						permitted={registrations.permitted}
						deniedHint="Needs permission to view extensions."
						hint={
							registrations.rows.length > registrations.liveCount
								? `${String(registrations.rows.length - registrations.liveCount)} binding(s) have lapsed and are being swept`
								: "Phones currently reachable by the switch."
						}
						href={routes.extensions}
					/>
					<LiveTile
						label="Active calls"
						value={calls.loaded ? String(calls.callCount) : null}
						permitted={calls.permitted}
						deniedHint="Needs permission to view call history."
						hint={
							calls.callCount === 0
								? "Nothing in progress."
								: `${String(calls.answeredCount)} answered, ${String(calls.legs.length)} legs`
						}
						href={routes.cdr}
					/>
					<LiveTile
						label="Agents available"
						value={agents.loaded ? String(agents.availableCount) : null}
						permitted={agents.permitted}
						deniedHint="Needs permission to monitor queues."
						hint={
							agents.staffedCount === 0
								? "Nobody is logged in."
								: `${String(agents.staffedCount)} logged in, ${String(agents.availableCount)} ready for the next caller`
						}
						href={routes.queues}
					/>
				</div>
			) : null}

			{connection === "refused" ? (
				<Card>
					<CardBody className="text-sm text-muted-foreground">
						The live connection was refused, which usually means the session ended or the active
						organization changed. Reload the page to reconnect.
					</CardBody>
				</Card>
			) : null}

			<div className="grid gap-4 sm:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle>Your access</CardTitle>
						<CardDescription>
							Resolved by the API from your membership role, not from this browser.
						</CardDescription>
					</CardHeader>
					<CardBody className="flex flex-col gap-3 text-sm">
						<Detail label="Signed in as" value={session.user.email} />
						<Detail label="Role" value={roleLabel(session.role)} />
						<Detail label="Permissions" value={`${session.permissions.length} granted`} />
						{session.session.impersonated ? (
							<Badge tone="warning">Impersonated session</Badge>
						) : null}
						{session.user.emailVerified ? null : <Badge tone="warning">Email not verified</Badge>}
					</CardBody>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>Where to go next</CardTitle>
						<CardDescription>The areas your role can reach.</CardDescription>
					</CardHeader>
					<CardBody>
						<ul className="flex flex-wrap gap-2">
							{reachable.map((item) => (
								<li key={item.url}>
									<Button size="sm" variant="secondary" render={<Link href={item.url} />}>
										{item.title}
									</Button>
								</li>
							))}
						</ul>
					</CardBody>
				</Card>
			</div>
		</>
	);
}

/**
 * One live figure.
 *
 * `value === null` means "not loaded yet" and renders an em dash — deliberately NOT `0`. The two
 * are indistinguishable on a dashboard and only one of them is a fact.
 */
function LiveTile({
	label,
	value,
	hint,
	href,
	permitted,
	deniedHint,
}: {
	label: string;
	value: string | null;
	hint: string;
	href: string;
	permitted: boolean;
	deniedHint: string;
}) {
	return (
		<Card>
			<CardBody className="flex flex-col gap-1">
				<div className="flex items-baseline justify-between gap-2">
					<p className="text-sm font-medium text-muted-foreground">{label}</p>
					<Link
						href={href}
						className="text-xs text-primary underline-offset-4 hover:underline"
					>
						Open
					</Link>
				</div>
				<p className="text-3xl font-semibold text-foreground" data-tabular>
					{permitted ? (value ?? "—") : "—"}
				</p>
				<p className="text-xs text-subtle-foreground">{permitted ? hint : deniedHint}</p>
			</CardBody>
		</Card>
	);
}

function Detail({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-baseline justify-between gap-4">
			<span className="text-muted-foreground">{label}</span>
			<span className="min-w-0 truncate font-medium text-foreground">{value}</span>
		</div>
	);
}
