import { TrunkDetail } from "../_components/trunk-detail";

export const metadata = { title: "Trunk" };

export default async function TrunkPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return <TrunkDetail trunkId={id} />;
}
