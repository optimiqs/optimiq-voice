"use client";

import { parseAsStringLiteral, useQueryState } from "nuqs";
import { PageHeader } from "~/components/ui/page-header";
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTrigger } from "~/components/ui/tabs";
import { SECURITY_TABS, type SecurityTab } from "~/lib/routes";
import { AccessRulesPanel } from "./access-rules-panel";
import { AuthFailuresPanel } from "./auth-failures-panel";

/**
 * SIP security: which networks may reach the edge, and what the edge refused.
 *
 * ## Why one page rather than two sidebar entries
 *
 * They are two views of ONE subject and both are gated by `security.read`, which is already the
 * argument Media and Numbers made. Here it is stronger than a grouping convenience: the attack log
 * is how an administrator finds out a rule is wrong — an `acl-denied` row for a branch office that
 * should have been allowed — and the rule list is where they fix it. Two routes would put the
 * question and the answer one navigation apart, and the fix would be made without the evidence on
 * screen.
 *
 * They are nonetheless not one TABLE. One is a small, editable list ordered by priority; the other
 * is an unbounded, windowed, cursor-paged ledger with no total. A surface that tried to be both
 * would page one of them wrongly.
 *
 * ## Why the tab is in the query string
 *
 * "The registrations from the Berlin office are failing" is a conversation that has to be linkable,
 * and a tab in component state is not. `securityTabHref` is the one place that knows the default
 * tab produces a bare `/security` — `clearOnDefault` keeps the URL matching the sidebar entry's
 * `href`, so the nav item does not stop looking active the moment somebody clicks the tab that is
 * already showing.
 */
const TAB_LABELS: Readonly<Record<SecurityTab, string>> = {
	"access-rules": "Access rules",
	"auth-failures": "Auth failures",
};

export function SecurityScreen() {
	const [tab, setTab] = useQueryState(
		"tab",
		parseAsStringLiteral(SECURITY_TABS)
			.withDefault("access-rules")
			.withOptions({ clearOnDefault: true }),
	);

	return (
		<>
			<PageHeader
				title="Security"
				description="Which networks may register phones, terminate calls, fetch provisioning or reach the API — and every attempt that was refused."
			/>

			<Tabs value={tab} onValueChange={(next) => void setTab(next as SecurityTab)}>
				<TabsList>
					{SECURITY_TABS.map((value) => (
						<TabsTrigger key={value} value={value}>
							{TAB_LABELS[value]}
						</TabsTrigger>
					))}
					<TabsIndicator />
				</TabsList>

				<TabsPanel value="access-rules">
					<AccessRulesPanel />
				</TabsPanel>
				<TabsPanel value="auth-failures">
					<AuthFailuresPanel />
				</TabsPanel>
			</Tabs>
		</>
	);
}
