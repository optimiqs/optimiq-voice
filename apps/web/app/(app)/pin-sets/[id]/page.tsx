import { PinSetDetail } from "../_components/pin-set-detail";

export const metadata = { title: "Authorisation codes" };

/**
 * Nested under `/pin-sets` so `getPagePermissions` inherits `pin-sets.read` by ancestry rather than
 * needing its own `PAGE_PERMISSIONS` entry saying the same thing.
 */
export default async function PinSetPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return <PinSetDetail pinSetId={id} />;
}
