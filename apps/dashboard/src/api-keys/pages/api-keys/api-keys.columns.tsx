import type { ColumnDef } from "@tanstack/react-table";
import type { ApiKey } from "~/api-keys/services/api-keys.interfaces";

/**
 * Column definitions for rendering a table of Optimiq Voice API Keys using TanStack Table.
 *
 * Each column maps a property of the `API Keys` object to a table header and cell.
 * This configuration enables sorting, filtering, and custom rendering in table UIs.
 */
export const columns = [
	{
		/**
		 * Unique identifier column for the API key.
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
		 * Human-readable name of the API key.
		 *
		 * Often used by users to identify a API key easily in the UI.
		 */
		id: "accessKeyId",
		header: "Access Key ID",
		accessorKey: "accessKeyId",
	},
] satisfies ColumnDef<ApiKey>[];
