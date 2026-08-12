import { SharedLineDetail } from "../_components/shared-line-detail";

export const metadata = { title: "Shared line" };

export default async function SharedLinePage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return <SharedLineDetail lineId={id} />;
}
