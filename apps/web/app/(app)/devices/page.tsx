import { DeviceIcon } from "~/components/ui/icons";
import { ModulePlaceholder } from "../_components/module-placeholder";

export const metadata = { title: "Devices" };

export default function DevicesPage() {
	return (
		<ModulePlaceholder
			title="Devices"
			description="Desk phones and softphones, their lines and their programmable keys."
			icon={<DeviceIcon className="size-5" />}
			whatsComing="Device inventory, line configuration and BLF key layouts arrive with the PBX MVP (roadmap P3); zero-touch provisioning for Yealink, Poly, Grandstream, Fanvil and Snom follows in P5."
		/>
	);
}
