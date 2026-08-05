import { QueueIcon } from "~/components/ui/icons";
import { ModulePlaceholder } from "../_components/module-placeholder";

export const metadata = { title: "Queues" };

export default function QueuesPage() {
	return (
		<ModulePlaceholder
			title="Queues"
			description="Call queues, their agents and their live state."
			icon={<QueueIcon className="size-5" />}
			whatsComing="Queues and ACD arrive with the business-depth wave (roadmap P5): distribution strategies, agent tiers, wrap-up rules, announcements, and a live wallboard."
		/>
	);
}
