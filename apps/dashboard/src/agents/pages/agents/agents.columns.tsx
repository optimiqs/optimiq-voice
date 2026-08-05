import type { Agent } from "@optimiq-voice/types";
import type { ColumnDef } from "@tanstack/react-table";

/**
 * Column definitions for rendering a table of Optimiq Voice Agents using TanStack Table.
 *
 * Each column maps a property of the `Agent` object to a table header and cell.
 * This configuration enables sorting, filtering, and custom rendering in table UIs.
 */
export const columns: ColumnDef<Agent>[] = [
	{
		/**
		 * Unique identifier column for the agent.
		 *
		 * - Typically a UUID or an internal reference string.
		 * - Helps uniquely identify each agent record.
		 * - Useful for backend linking, debugging, or API interactions.
		 */
		id: "ref",
		header: "Ref",
		accessorKey: "ref",
	},
	{
		/**
		 * Human-readable name of the agent.
		 *
		 * - Makes it easier for users to identify agents.
		 * - Can be a friendly name or descriptive label.
		 */
		id: "name",
		header: "Name",
		accessorKey: "name",
	},
	{
		/**
		 * Username associated with the agent.
		 *
		 * - Indicates which user account is using this agent.
		 * - Often corresponds to the SIP username or system login.
		 * - Useful for administrators to manage credentials.
		 */
		id: "username",
		header: "Username",
		accessorKey: "username",
	},
	{
		/**
		 * Domain URI to which the agent belongs.
		 *
		 * - Renders the domain URI of the associated domain.
		 * - Useful for distinguishing agents across different SIP domains or tenants.
		 * - Enhances context for administrators managing multiple domains.
		 */
		id: "domain",
		header: "Domain URI",
		accessorKey: "domain",
		cell: ({ row }) => {
			const domain = (row.original as any).domain;
			return domain?.domainUri || "";
		},
	},
	{
		/**
		 * Status of the agent.
		 *
		 * - Displays whether the agent is enabled or disabled.
		 * - Uses a custom cell renderer to show a human-readable status.
		 * - Helps admins quickly see which agents are active or inactive.
		 */
		id: "status",
		header: "Status",
		accessorKey: "enabled",
		cell: ({ row }) => (row.original.enabled ? "Enabled" : "Disabled"),
	},
	{
		/**
		 * Privacy setting of the agent.
		 *
		 * - Indicates if privacy is enabled for this agent.
		 * - Can be used to control features like SIP privacy or caller ID suppression.
		 */
		id: "privacy",
		header: "Privacy",
		accessorKey: "privacy",
	},
];
