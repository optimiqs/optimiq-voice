import { MenuIcon } from "~/components/ui/icons";
import { ModulePlaceholder } from "../_components/module-placeholder";

export const metadata = { title: "IVR menus" };

export default function IvrPage() {
	return (
		<ModulePlaceholder
			title="IVR menus"
			description="Auto-attendant menus, their prompts and their nested options."
			icon={<MenuIcon className="size-5" />}
			whatsComing="The IVR builder arrives with the PBX MVP (roadmap P3): greetings, digit options, timeout and invalid handling, and menus nested to any depth."
		/>
	);
}
