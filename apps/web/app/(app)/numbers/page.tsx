import { HashIcon } from "~/components/ui/icons";
import { ModulePlaceholder } from "../_components/module-placeholder";

export const metadata = { title: "Numbers" };

export default function NumbersPage() {
	return (
		<ModulePlaceholder
			title="Numbers"
			description="Inbound numbers, their treatment and their emergency dispatch location."
			icon={<HashIcon className="size-5" />}
			whatsComing="Number inventory arrives with the PBX MVP (roadmap P3): inbound routing to an extension, ring group, IVR or queue, caller-ID overrides, and the dispatchable location required by Kari's Law and RAY BAUM'S Act."
		/>
	);
}
