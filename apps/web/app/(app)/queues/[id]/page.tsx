import { QueueDetail } from "../_components/queue-detail";

export const metadata = { title: "Queue" };

export default async function QueuePage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return <QueueDetail queueId={id} />;
}
