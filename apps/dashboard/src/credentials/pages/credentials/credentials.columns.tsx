import type { Credentials } from "@optimiq-voice/types";
import type { ColumnDef } from "@tanstack/react-table";

/**
 * Column definitions for rendering a table of Optimiq Voice Credentials using TanStack Table.
 *
 * Each column maps a property of the `Credentials` object to a table header and cell.
 * This configuration enables sorting, filtering, and custom rendering in table UIs.
 */
export const columns: ColumnDef<Credentials>[] = [
  {
    /**
     * Unique identifier column for the credential.
     *
     * Typically a UUID or internal reference string, used for identifying
     * the row uniquely within the table and backend systems.
     */
    id: "ref",
    header: "Ref",
    accessorKey: "ref"
  },
  {
    /**
     * Human-readable name of the credential.
     *
     * Often used by users to identify a credential easily in the UI.
     */
    id: "name",
    header: "Name",
    accessorKey: "name"
  },
  {
    /**
     * Username associated with the credential.
     *
     * This helps track which username is using this credential.
     */
    id: "username",
    header: "Username",
    accessorKey: "username"
  }
];
