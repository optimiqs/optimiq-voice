import { HistoryIcon } from "~/components/ui/icons";
import { ModulePlaceholder } from "../_components/module-placeholder";

export const metadata = { title: "Call history" };

export default function CdrPage() {
	return (
		<ModulePlaceholder
			title="Call history"
			description="Per-leg call detail records and reporting exports."
			icon={<HistoryIcon className="size-5" />}
			whatsComing="Call history arrives with the engine wave (roadmap P2): per-leg records with linked A and B legs, hangup causes, transfer and bridge events, and CSV export."
		/>
	);
}
