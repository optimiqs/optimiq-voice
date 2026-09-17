"use client";

import { parseAsStringLiteral, useQueryState } from "nuqs";
import { PageHeader } from "~/components/ui/page-header";
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTrigger } from "~/components/ui/tabs";
import { ROUTING_TABS, type RoutingTab } from "~/lib/routes";
import {
	FeatureCodesPanel,
	InboundRoutesPanel,
	OutboundRoutesPanel,
	TimeConditionsPanel,
	TranslationRulesetsPanel,
} from "./routing-panels";
import { RoutingToolsPanel } from "./routing-tools-panel";

/**
 * Routing: six views of one subject.
 *
 * Inbound routes, outbound routes, time conditions, number translations and feature codes are all
 * gated by `routes.*` (or, for two of them, by a permission this page's `PAGE_PERMISSIONS` entry
 * already names) and all answer the same question — how does a call get from where it arrives to
 * where it should go. Five sidebar entries would be five ways to say "routing", and five
 * `PAGE_PERMISSIONS` entries that all have to say the same thing. One page, with the section in the
 * URL, keeps every view linkable without any of that.
 *
 * Translations joined rather than going to the Dial plan page, and the permission is what decided
 * it: a ruleset rides `routes.*`, so filing it beside the aliases and streams under `dial-plan.*`
 * would have hidden it from the people who own the routes that carry it. Call flows went the other
 * way, to a route of their own, because `call-flows.toggle` is held by somebody who owns no part of
 * this page.
 *
 * The tab lives in `?tab=` rather than in component state for the same reason the list search
 * does: a support conversation is "look at the outbound route" and that has to be a link.
 */
const TAB_LABELS: Readonly<Record<RoutingTab, string>> = {
	inbound: "Inbound",
	outbound: "Outbound",
	"time-conditions": "Time conditions",
	translations: "Number translations",
	"feature-codes": "Feature codes",
	tools: "Compile & simulate",
};

export function RoutingScreen() {
	const [tab, setTab] = useQueryState(
		"tab",
		parseAsStringLiteral(ROUTING_TABS).withDefault("inbound").withOptions({ clearOnDefault: true }),
	);

	return (
		<>
			<PageHeader
				title="Routing"
				description="How a call gets from where it arrives to where it should go. Every save recompiles the routing model — a change that would break it is rolled back rather than stored."
			/>

			<Tabs value={tab} onValueChange={(next) => void setTab(next as RoutingTab)}>
				<TabsList>
					{ROUTING_TABS.map((value) => (
						<TabsTrigger key={value} value={value}>
							{TAB_LABELS[value]}
						</TabsTrigger>
					))}
					<TabsIndicator />
				</TabsList>

				<TabsPanel value="inbound">
					<InboundRoutesPanel />
				</TabsPanel>
				<TabsPanel value="outbound">
					<OutboundRoutesPanel />
				</TabsPanel>
				<TabsPanel value="time-conditions">
					<TimeConditionsPanel />
				</TabsPanel>
				<TabsPanel value="translations">
					<TranslationRulesetsPanel />
				</TabsPanel>
				<TabsPanel value="feature-codes">
					<FeatureCodesPanel />
				</TabsPanel>
				<TabsPanel value="tools">
					<RoutingToolsPanel />
				</TabsPanel>
			</Tabs>
		</>
	);
}
