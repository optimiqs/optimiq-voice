import { IvrMenuDetail } from "../_components/ivr-menu-detail";

export const metadata = { title: "IVR menu" };

/**
 * `/ivr/<id>` inherits `ivr.read` by ancestry — `getPagePermissions` walks up to `/ivr` when a
 * path is not declared, so a nested view can never be less protected than its parent.
 */
export default async function IvrMenuPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return <IvrMenuDetail menuId={id} />;
}
