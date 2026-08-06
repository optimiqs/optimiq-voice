import { TimeConditionDetail } from "../../_components/time-condition-detail";

export const metadata = { title: "Time condition" };

/**
 * Nested under `/routing` so `getPagePermissions` inherits `routes.read` by ancestry rather than
 * needing its own `PAGE_PERMISSIONS` entry saying the same thing.
 */
export default async function TimeConditionPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return <TimeConditionDetail conditionId={id} />;
}
