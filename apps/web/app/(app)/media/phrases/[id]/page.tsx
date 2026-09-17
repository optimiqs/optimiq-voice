import { PhraseDetail } from "../../_components/phrase-detail";

export const metadata = { title: "Phrase" };

/**
 * Nested under `/media` so the sequence lives beside the recordings it names — and the ONE detail
 * route in this app that does not inherit its parent's permission by ancestry.
 *
 * `/media` is gated by `settings.read`, which is what the hold-music and prompt endpoints ask for
 * and which every self-service role holds so a preferences screen renders. The phrases endpoints ask
 * for `recordings.read` instead, on the server's argument that a phrase is a media-library row.
 * Inheriting would have opened this page for a role the API refuses on the first read, so
 * `PAGE_PERMISSIONS` names the route explicitly with the `[id]` wildcard.
 */
export default async function PhrasePage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return <PhraseDetail phraseId={id} />;
}
