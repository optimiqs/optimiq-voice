import type { INumber } from "@optimiq-voice/types";
import type { ColumnDef } from "@tanstack/react-table";

/**
 * Column definitions for rendering a table of Optimiq Voice Numbers using TanStack Table.
 *
 * Each column maps a property of the `INumber` object to a table header and cell.
 * This configuration enables sorting, filtering, and custom rendering in table UIs.
 */
export const columns: ColumnDef<INumber>[] = [
	{
		/**
		 * Unique identifier column for the number.
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
		 * Human-readable name of the number.
		 *
		 * Often used by users to identify a number easily in the UI.
		 */
		id: "name",
		header: "Name",
		accessorKey: "name",
	},
	{
		/**
		 * Telephone URL associated with the number.
		 *
		 * This represents the SIP or telephone endpoint for the number.
		 */
		id: "telUrl",
		header: "Tel URL",
		accessorKey: "telUrl",
	},
	{
		/**
		 * Formatted address composed of city, country, and ISO country code.
		 *
		 * Combines the city, country, and ISO code into a single cell for easier reading.
		 */
		id: "address",
		header: "Address",
		accessorFn: (row) => {
			const { city, country, countryIsoCode } = row;
			return `${city}, ${country} (${countryIsoCode})`;
		},
	},
	{
		/**
		 * Agent AOR (Address of Record) associated with the number.
		 *
		 * Represents the SIP endpoint or user that handles calls to this number.
		 */
		id: "agentAor",
		header: "Agent AOR",
		accessorKey: "agentAor",
	},
	{
		/**
		 * Reference to the application linked to this number.
		 *
		 * This helps track which application is using this number.
		 */
		id: "appRef",
		header: "Application Ref",
		accessorKey: "appRef",
	},
];
