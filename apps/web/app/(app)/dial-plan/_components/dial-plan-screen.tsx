"use client";

import { parseAsStringLiteral, useQueryState } from "nuqs";
import { PageHeader } from "~/components/ui/page-header";
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTrigger } from "~/components/ui/tabs";
import { DIAL_PLAN_TABS, type DialPlanTab } from "~/lib/routes";
import { AliasesPanel, DirectoriesPanel, SpeedDialsPanel, StreamsPanel } from "./dial-plan-panels";

/**
 * The dial plan's named building blocks: four tables, one permission family, one page.
 *
 * The collapse is the permission registry's and it is worth restating on the screen it produced.
 * The test a wave has to pass before four resources become one is whether they have DIFFERENT power
 * profiles, and these do not: each is a named thing an administrator points other routing at, none
 * reaches a trunk except through the outbound tables every other destination goes through, and there
 * is no role that plausibly edits one and not the others. Four sidebar entries would be four ways to
 * say "the things routing points at", and four `PAGE_PERMISSIONS` entries all saying `dial-plan.read`.
 *
 * Number translations are deliberately NOT here even though they read as a fifth building block:
 * they ride `routes.*` rather than `dial-plan.*`, so a tab on this page would have needed a route
 * requirement that named one permission and hid the other. They are a tab of Routing instead, beside
 * the routes and trunks that carry them.
 */
const TAB_LABELS: Readonly<Record<DialPlanTab, string>> = {
	aliases: "Named destinations",
	streams: "Audio streams",
	directories: "Dial-by-name",
	"speed-dials": "Speed dials",
};

export function DialPlanScreen() {
	const [tab, setTab] = useQueryState(
		"tab",
		parseAsStringLiteral(DIAL_PLAN_TABS)
			.withDefault("aliases")
			.withOptions({ clearOnDefault: true }),
	);

	return (
		<>
			<PageHeader
				title="Dial plan"
				description="The named pieces routing is assembled from — a destination other rows point at, a remote audio source, a keypad directory, a short code. Every save recompiles the routing model."
			/>

			<Tabs value={tab} onValueChange={(next) => void setTab(next as DialPlanTab)}>
				<TabsList>
					{DIAL_PLAN_TABS.map((value) => (
						<TabsTrigger key={value} value={value}>
							{TAB_LABELS[value]}
						</TabsTrigger>
					))}
					<TabsIndicator />
				</TabsList>

				<TabsPanel value="aliases">
					<AliasesPanel />
				</TabsPanel>
				<TabsPanel value="streams">
					<StreamsPanel />
				</TabsPanel>
				<TabsPanel value="directories">
					<DirectoriesPanel />
				</TabsPanel>
				<TabsPanel value="speed-dials">
					<SpeedDialsPanel />
				</TabsPanel>
			</Tabs>
		</>
	);
}
