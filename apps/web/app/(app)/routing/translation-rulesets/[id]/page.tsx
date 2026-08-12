import { TranslationRulesetDetail } from "../../_components/translation-ruleset-detail";

export const metadata = { title: "Translation ruleset" };

/**
 * Nested under `/routing` so `getPagePermissions` inherits `routes.read` by ancestry — which is the
 * correct requirement here rather than a convenient one: a ruleset is guarded by `routes.*` on the
 * server precisely because it is only meaningful attached to a route or a trunk.
 */
export default async function TranslationRulesetPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	return <TranslationRulesetDetail rulesetId={id} />;
}
