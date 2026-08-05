import { RecordIcon } from "~/components/ui/icons";
import { ModulePlaceholder } from "../_components/module-placeholder";

export const metadata = { title: "Recordings" };

export default function RecordingsPage() {
	return (
		<ModulePlaceholder
			title="Recordings"
			description="Call recordings, their retention policy and their media."
			icon={<RecordIcon className="size-5" />}
			whatsComing="Recordings arrive with the engine wave (roadmap P2): searchable per-call media on object storage with signed download URLs, ownership checks and retention rules."
		/>
	);
}
