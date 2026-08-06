"use client";

import { parseAsStringLiteral, useQueryState } from "nuqs";
import { PageHeader } from "~/components/ui/page-header";
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTrigger } from "~/components/ui/tabs";
import { QUEUE_TABS, type QueueTab } from "~/lib/routes";
import { AgentConsole } from "./agent-console";
import { QueueAgentsPanel } from "./queue-agents-panel";
import { QueuesPanel } from "./queues-panel";

/**
 * Queues and the agents who answer them: two views of one subject, on one page.
 *
 * They are not two pages because an agent is not a child of a queue. `queue_agent` carries no queue
 * id — one agent serves several queues through a tier — so `/api/v1/queue-agents` is top-level, and
 * a queue's page has nowhere to put the org-wide agent list. A second sidebar entry would be a
 * second way to say "queues" and a second `PAGE_PERMISSIONS` line saying `queues.read` again.
 *
 * The tab lives in `?tab=` for the same reason every list's search does: "look at the agent" has to
 * be a link.
 */
const TAB_LABELS: Readonly<Record<QueueTab, string>> = {
	queues: "Queues",
	agents: "Agents",
};

export function QueuesScreen() {
	const [tab, setTab] = useQueryState(
		"tab",
		parseAsStringLiteral(QUEUE_TABS).withDefault("queues").withOptions({ clearOnDefault: true }),
	);

	return (
		<>
			<PageHeader
				title="Queues"
				description="Callers wait in a queue until a staffed agent is free. The queue decides how long they wait and who they are offered to; a membership decides who is staffed, and that is a separate permission."
			/>

			{/*
			 * The console renders only for a user whose account is linked to an agent seat, so for
			 * everyone else this line is nothing at all rather than an empty state apologising for
			 * a feature that does not apply to them.
			 */}
			<AgentConsole />

			<Tabs value={tab} onValueChange={(next) => void setTab(next as QueueTab)}>
				<TabsList>
					{QUEUE_TABS.map((value) => (
						<TabsTrigger key={value} value={value}>
							{TAB_LABELS[value]}
						</TabsTrigger>
					))}
					<TabsIndicator />
				</TabsList>

				<TabsPanel value="queues">
					<QueuesPanel />
				</TabsPanel>
				<TabsPanel value="agents">
					<QueueAgentsPanel />
				</TabsPanel>
			</Tabs>
		</>
	);
}
