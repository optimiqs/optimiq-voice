import type { Secret } from "@optimiq-voice/types";
import type { ColumnDef } from "@tanstack/react-table";

/**
 * Column definitions for rendering a table of Optimiq Voice Secrets using TanStack Table.
 *
 * Each column maps a property of the `Secrets` object to a table header and cell.
 * This configuration enables sorting, filtering, and custom rendering in table UIs.
 */
export const columns: ColumnDef<Secret>[] = [
  {
    /**
     * Unique identifier column for the secret.
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
     * Human-readable name of the secret.
     *
     * Often used by users to identify a secret easily in the UI.
     */
    id: "name",
    header: "Name",
    accessorKey: "name"
  }
];
