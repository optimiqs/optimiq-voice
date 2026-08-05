import { TrunkIcon } from "~/components/ui/icons";
import { ModulePlaceholder } from "../_components/module-placeholder";

export const metadata = { title: "Trunks" };

export default function TrunksPage() {
	return (
		<ModulePlaceholder
			title="Trunks"
			description="Carrier connections, their registrations and their credentials."
			icon={<TrunkIcon className="size-5" />}
			whatsComing="Trunk configuration arrives with the PBX MVP (roadmap P3): registration and authentication, codec preferences, channel caps, failover order and live registration state."
		/>
	);
}
