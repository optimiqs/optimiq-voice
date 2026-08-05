import { RouteIcon } from "~/components/ui/icons";
import { ModulePlaceholder } from "../_components/module-placeholder";

export const metadata = { title: "Routing" };

export default function RoutingPage() {
	return (
		<ModulePlaceholder
			title="Routing"
			description="Inbound and outbound routes, dial patterns, time conditions and feature codes."
			icon={<RouteIcon className="size-5" />}
			whatsComing="The route builder arrives with the PBX MVP (roadmap P3). Routes are first-class records compiled into the runtime routing model — nothing here will ever be a hand-edited dialplan."
		/>
	);
}
