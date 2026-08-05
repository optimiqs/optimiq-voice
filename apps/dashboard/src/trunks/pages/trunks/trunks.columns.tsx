import type { Trunk } from "@optimiq-voice/types";
import type { ColumnDef } from "@tanstack/react-table";

/**
 * Column definitions for rendering a table of Optimiq Voice Trunks using TanStack Table.
 *
 * Each column maps a property of the `Trunk` object to a table header and cell.
 * This configuration enables sorting, filtering, and custom rendering in table UIs.
 */
export const columns: ColumnDef<Trunk>[] = [
	{
		/**
		 * Unique identifier for the trunk.
		 *
		 * Typically a UUID or internal reference string used to identify the row uniquely.
		 */
		id: "ref",
		header: "Ref",
		accessorKey: "ref",
	},
	{
		/**
		 * Human-readable name of the trunk.
		 *
		 * Often used by users to easily identify the trunk in the UI.
		 */
		id: "name",
		header: "Name",
		accessorKey: "name",
	},
	{
		/**
		 * Indicates whether the trunk is configured to send SIP REGISTER requests.
		 *
		 * Typically a boolean or string value.
		 */
		id: "sendRegister",
		header: "Send Register",
		accessorKey: "sendRegister",
	},
	{
		/**
		 * URI used by the trunk for inbound SIP traffic.
		 *
		 * This field helps configure SIP endpoints and routing.
		 */
		id: "inboundUri",
		header: "Inbound SIP URI",
		accessorKey: "inboundUri",
	},
];
