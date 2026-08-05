import { UsersIcon } from "~/components/ui/icons";
import { ModulePlaceholder } from "../_components/module-placeholder";

export const metadata = { title: "Ring groups" };

export default function RingGroupsPage() {
	return (
		<ModulePlaceholder
			title="Ring groups"
			description="Simultaneous, sequential and rollover hunt groups."
			icon={<UsersIcon className="size-5" />}
			whatsComing="Ring groups arrive with the PBX MVP (roadmap P3): ring strategy, per-destination delay and timeout, and the action taken when nobody answers."
		/>
	);
}
