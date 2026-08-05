import { PhoneIcon } from "~/components/ui/icons";
import { ModulePlaceholder } from "../_components/module-placeholder";

export const metadata = { title: "Extensions" };

export default function ExtensionsPage() {
	return (
		<ModulePlaceholder
			title="Extensions"
			description="Internal endpoints, their dialling behaviour and their user assignment."
			icon={<PhoneIcon className="size-5" />}
			whatsComing="Extensions arrive with the PBX MVP (roadmap P3): number and alias, caller ID, voicemail, forwarding and do-not-disturb, follow-me, and the devices bound to each one."
		/>
	);
}
