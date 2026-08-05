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
import { useAppSession } from "./_context/session-context";

/**
 * The landing surface.
 *
 * Live call and registration counts belong here, but they come from the engine's WebSocket
 * fan-out, which does not exist yet (roadmap P2). Rather than invent metrics, this shows what the
 * session actually is — who you are, which tenant you are acting in, and what that grants — which
 * is also the fastest way to tell whether auth is wired correctly.
 */
export default function OverviewPage() {
	const session = useAppSession();
	const granted = new Set<string>(session.permissions);
	const organization = session.activeOrganization;

	const reachable = NAV_SECTIONS.flatMap((section) => section.items).filter(
		(item) => item.url !== routes.overview && canAccessPage(item.url, granted),
	);

	return (
		<>
			<PageHeader
				title={organization ? organization.name : "Dashboard"}
				description="Live call, registration and queue activity will appear here once the engine's event stream lands."
				actions={
					<Button variant="secondary" render={<Link href={routes.settings} />}>
						Organization settings
					</Button>
				}
			/>

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
						<CardDescription>
							The areas your role can reach. Most open once the PBX entities ship.
						</CardDescription>
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

function Detail({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-baseline justify-between gap-4">
			<span className="text-muted-foreground">{label}</span>
			<span className="min-w-0 truncate font-medium text-foreground">{value}</span>
		</div>
	);
}
