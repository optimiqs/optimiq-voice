import { VoicemailIcon } from "~/components/ui/icons";
import { ModulePlaceholder } from "../_components/module-placeholder";

export const metadata = { title: "Voicemail" };

export default function VoicemailPage() {
	return (
		<ModulePlaceholder
			title="Voicemail"
			description="Mailboxes, greetings, messages and message-waiting indication."
			icon={<VoicemailIcon className="size-5" />}
			whatsComing="Voicemail arrives with the PBX MVP (roadmap P3): per-extension mailboxes, custom greetings, email delivery, and message-waiting indication on registered devices."
		/>
	);
}
