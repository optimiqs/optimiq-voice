"use client";

import { parseAsStringLiteral, useQueryState } from "nuqs";
import { PageHeader } from "~/components/ui/page-header";
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTrigger } from "~/components/ui/tabs";
import { CONFERENCE_TABS, type ConferenceTab } from "~/lib/routes";
import { LiveIndicator } from "../../queues/_components/agent-console";
import { ConferencesPanel } from "./conferences-panel";
import { LiveConferencesPanel } from "./live-conferences-panel";

/**
 * Conference rooms, and the meetings running in them: two views of one subject, on one page.
 *
 * The ROW and the MEETING are genuinely different things — editing a room's recording policy is
 * forever and muting somebody lasts as long as they are on the call, which is why the API keeps them
 * in two controllers behind two grants — but they are two views of the same room, and `lib/routes.ts`
 * argues why that makes them tabs rather than a second route or a detail page that does not exist.
 *
 * Both tabs are reachable with `conferences.read`. The live tab's CONTROLS are gated a second time,
 * inside the panel, on `conferences.moderate`.
 */
const TAB_LABELS: Readonly<Record<ConferenceTab, string>> = {
	rooms: "Rooms",
	live: "Active conferences",
};

export function ConferencesScreen() {
	const [tab, setTab] = useQueryState(
		"tab",
		parseAsStringLiteral(CONFERENCE_TABS)
			.withDefault("rooms")
			.withOptions({ clearOnDefault: true }),
	);

	return (
		<>
			<PageHeader
				title="Conferences"
				description="Rooms people dial to end up in the same call. PINs are managed separately — the API hashes them behind an endpoint rather than accepting a digest here."
				actions={tab === "live" ? <LiveIndicator /> : null}
			/>

			<Tabs value={tab} onValueChange={(next) => void setTab(next as ConferenceTab)}>
				<TabsList>
					{CONFERENCE_TABS.map((value) => (
						<TabsTrigger key={value} value={value}>
							{TAB_LABELS[value]}
						</TabsTrigger>
					))}
					<TabsIndicator />
				</TabsList>

				<TabsPanel value="rooms">
					<ConferencesPanel />
				</TabsPanel>
				{/*
				 * Mounted only while selected, which is Base UI's default (`keepMounted: false`) and is
				 * relied on here rather than merely inherited: this panel's mount is what opens the
				 * `conferences` live subscription, and that pulls the whole claims bucket plus every
				 * conference event in the organization. Kept mounted behind a tab nobody is looking at,
				 * every visit to the rooms list would open a live feed the visitor did not ask for.
				 */}
				<TabsPanel value="live">
					<LiveConferencesPanel />
				</TabsPanel>
			</Tabs>
		</>
	);
}
