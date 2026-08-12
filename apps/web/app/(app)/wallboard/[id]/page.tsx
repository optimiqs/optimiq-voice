import { OperatorPanel } from "../_components/operator-panel";

export const metadata = { title: "Queue floor" };

export default async function WallboardQueuePage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return <OperatorPanel queueId={id} />;
}
