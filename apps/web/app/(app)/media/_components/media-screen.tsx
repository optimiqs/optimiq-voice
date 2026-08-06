"use client";

import { parseAsStringLiteral, useQueryState } from "nuqs";
import { PageHeader } from "~/components/ui/page-header";
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTrigger } from "~/components/ui/tabs";
import { MEDIA_TABS, type MediaTab } from "~/lib/routes";
import { MohClassesPanel } from "./moh-classes-panel";
import { PromptsPanel } from "./prompts-panel";

/**
 * Everything the phone system can play, on one page with two tabs.
 *
 * ## Why one page rather than two sidebar entries
 *
 * Hold music and prompts are the SAME subject to the person managing them — audio somebody uploads
 * so a caller can hear it — and they are managed by the same people under the same grant
 * (`settings.read` / `settings.write`, which is what `PAGE_PERMISSIONS` declares for `/media` and
 * what both resources' descriptors ask for). Two routes would mean two sidebar lines saying
 * "audio", two `PAGE_PERMISSIONS` entries repeating one permission, and a user who uploaded a file
 * to the wrong one of them having to go looking. This mirrors Numbers, which made the same call for
 * the same reasons.
 *
 * They are nonetheless not one LIST, and that is not a contradiction: a hold-music class is a
 * playlist with a sample rate and a stream option, a prompt is a single object with a language tag,
 * and a table that tried to show both would have a column that is empty for half its rows.
 *
 * ## Why the tab is in the query string
 *
 * The same reason every list's search and page are: "the hold music is wrong" is a conversation
 * that has to be linkable, and a tab in component state is not. `mediaTabHref` is the one place
 * that knows the default tab produces a bare `/media` — `clearOnDefault` keeps the URL the nav
 * link's `href` matches, so the sidebar entry does not stop looking active the moment somebody
 * clicks the tab that is already showing.
 */
const TAB_LABELS: Readonly<Record<MediaTab, string>> = {
	"hold-music": "Hold music",
	prompts: "Prompts",
};

export function MediaScreen() {
	const [tab, setTab] = useQueryState(
		"tab",
		parseAsStringLiteral(MEDIA_TABS)
			.withDefault("hold-music")
			.withOptions({ clearOnDefault: true }),
	);

	return (
		<>
			<PageHeader
				title="Media"
				description="The audio this phone system plays: what a caller hears while they wait, and the recordings an IVR or an announcement points at."
			/>

			<Tabs value={tab} onValueChange={(next) => void setTab(next as MediaTab)}>
				<TabsList>
					{MEDIA_TABS.map((value) => (
						<TabsTrigger key={value} value={value}>
							{TAB_LABELS[value]}
						</TabsTrigger>
					))}
					<TabsIndicator />
				</TabsList>

				<TabsPanel value="hold-music">
					<MohClassesPanel />
				</TabsPanel>
				<TabsPanel value="prompts">
					<PromptsPanel />
				</TabsPanel>
			</Tabs>
		</>
	);
}
