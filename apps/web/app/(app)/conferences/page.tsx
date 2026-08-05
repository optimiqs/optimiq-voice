import { ConferenceIcon } from "~/components/ui/icons";
import { ModulePlaceholder } from "../_components/module-placeholder";

export const metadata = { title: "Conferences" };

export default function ConferencesPage() {
	return (
		<ModulePlaceholder
			title="Conferences"
			description="Conference rooms, PINs and in-conference moderation."
			icon={<ConferenceIcon className="size-5" />}
			whatsComing="Conference rooms arrive with the business-depth wave (roadmap P5): participant and moderator PINs, and live mute, kick, lock and record controls."
		/>
	);
}
