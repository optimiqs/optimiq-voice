import { PagingGroupDetail } from "../_components/paging-group-detail";

export const metadata = { title: "Paging group" };

export default async function PagingGroupPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return <PagingGroupDetail groupId={id} />;
}
