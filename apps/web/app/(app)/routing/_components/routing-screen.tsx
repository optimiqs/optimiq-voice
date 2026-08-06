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
} from "./routing-panels";
import { RoutingToolsPanel } from "./routing-tools-panel";

/**
 * Routing: five views of one subject.
 *
 * Inbound routes, outbound routes, time conditions and feature codes are all gated by `routes.*`
 * and all answer the same question — how does a call get from where it arrives to where it should
 * go. Four sidebar entries would be four ways to say "routing", and four `PAGE_PERMISSIONS`
 * entries that all have to say the same thing. One page, with the section in the URL, keeps every
 * view linkable without any of that.
 *
 * The tab lives in `?tab=` rather than in component state for the same reason the list search
 * does: a support conversation is "look at the outbound route" and that has to be a link.
 */
const TAB_LABELS: Readonly<Record<RoutingTab, string>> = {
	inbound: "Inbound",
	outbound: "Outbound",
	"time-conditions": "Time conditions",
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
