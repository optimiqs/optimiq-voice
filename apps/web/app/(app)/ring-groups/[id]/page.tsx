import { RingGroupDetail } from "../_components/ring-group-detail";

export const metadata = { title: "Ring group" };

export default async function RingGroupPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return <RingGroupDetail groupId={id} />;
}
