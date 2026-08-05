import { Box } from "@mui/material";
import { Tooltip } from "~/core/components/design-system/ui/tooltip/tooltip";
import type { Acl } from "@optimiq-voice/types";
import type { ColumnDef } from "@tanstack/react-table";

/**
 * Column definitions for rendering a table of Optimiq Voice ACLs using TanStack Table.
 *
 * Each column maps a property of the `Acl` object to a table header and cell.
 * This configuration enables sorting, filtering, and custom rendering in table UIs.
 */
export const columns: ColumnDef<Acl>[] = [
	{
		/**
		 * Unique identifier column for the ACL.
		 *
		 * Typically a UUID or internal reference string, used for identifying
		 * the row uniquely within the table and backend systems.
		 */
		id: "ref",
		header: "Ref",
		accessorKey: "ref",
	},
	{
		/**
		 * Human-readable name of the ACL.
		 *
		 * Often used by users to identify an ACL easily in the UI.
		 */
		id: "name",
		header: "Name",
		accessorKey: "name",
	},
	{
		/**
		 * Allow List column.
		 *
		 * Renders a comma-separated list of allowed permissions or
		 * "No permissions" if the list is empty.
		 *
		 * This allows the user to quickly see what resources are accessible
		 * under this ACL.
		 */
		id: "allow",
		header: "Allow List",
		accessorKey: "allow",
		cell: ({ row }) => {
			const allowList = row.getValue("allow") as string[];
			const label = allowList.length > 0 ? allowList.join(", ") : "No rules";

			return (
				<Tooltip title={label}>
					<Box
						component="span"
						sx={{
							display: "inline-block",
							maxWidth: "200px",
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
						}}
					>
						{label}
					</Box>
				</Tooltip>
			);
		},
	},
];
