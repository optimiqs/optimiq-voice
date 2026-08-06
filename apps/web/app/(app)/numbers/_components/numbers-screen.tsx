"use client";

import { parseAsStringLiteral, useQueryState } from "nuqs";
import { PageHeader } from "~/components/ui/page-header";
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTrigger } from "~/components/ui/tabs";
import { NUMBER_TABS, type NumberTab } from "~/lib/routes";
import { NumbersPanel } from "./numbers-panel";
import { OrderNumberPanel } from "./order-number-panel";

/**
 * The DIDs you own, and the ones you could buy: two views of one subject, on one page.
 *
 * Not two routes, for the reason the Queues and Routing pages are not either — a second sidebar
 * entry called "Order numbers" is a second way to say "numbers", and a second route would need a
 * `PAGE_PERMISSIONS` line repeating `numbers.read`. Both views are about the same thing and both
 * are reached by the same people.
 *
 * The order tab is visible to anyone who can read numbers, and its controls are gated on
 * `numbers.order` inside the panel. Hiding the tab from a manager would hide the existence of the
 * feature; showing it with an explanation tells them what to ask for.
 */
const TAB_LABELS: Readonly<Record<NumberTab, string>> = {
	numbers: "Your numbers",
	order: "Order a number",
};

export function NumbersScreen() {
	const [tab, setTab] = useQueryState(
		"tab",
		parseAsStringLiteral(NUMBER_TABS).withDefault("numbers").withOptions({ clearOnDefault: true }),
	);

	return (
		<>
			<PageHeader
				title="Numbers"
				description="The DIDs your carrier delivers, and where a call to each one goes when no inbound route claims it."
			/>

			<Tabs value={tab} onValueChange={(next) => void setTab(next as NumberTab)}>
				<TabsList>
					{NUMBER_TABS.map((value) => (
						<TabsTrigger key={value} value={value}>
							{TAB_LABELS[value]}
						</TabsTrigger>
					))}
					<TabsIndicator />
				</TabsList>

				<TabsPanel value="numbers">
					<NumbersPanel />
				</TabsPanel>
				<TabsPanel value="order">
					<OrderNumberPanel />
				</TabsPanel>
			</Tabs>
		</>
	);
}
