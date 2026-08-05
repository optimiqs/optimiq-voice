import { Box } from "@mui/material";
import { useDataTable } from "../data-table.context";
import { DataTableToolbarFilters } from "./data-table-toolbar-filters";
import { DataTableToolbarPagination } from "./data-table-toolbar-pagination";
import { DataTableToolbarSelection } from "./data-table-toolbar-selection";
import { DataTableToolbarElement } from "./data-table.styles";

export const DataTableToolbar = () => {
  const { features } = useDataTable();

  if (!features.includes("filters") && !features.includes("selection")) {
    return null;
  }

  return (
    <DataTableToolbarElement>
      <Box display="flex" gap="12px" alignItems="center">
        <DataTableToolbarSelection />
        <DataTableToolbarFilters />
      </Box>

      <Box display="flex" gap={2} alignItems="center">
        <DataTableToolbarPagination />
      </Box>
    </DataTableToolbarElement>
  );
};
