import { Box } from "@mui/material";
import { flexRender, type Header } from "@tanstack/react-table";
import { useCallback } from "react";
import { useDataTable } from "../data-table.context";
import { SortMenu } from "./data-table-sort-menu";
import { TableCellRoot } from "./data-table.styles";
import type { SortOrder } from "../data-table.interfaces";

export interface DataTableColumnHeaderProps<TData, TValue> {
  header: Header<TData, TValue>;
}

export function DataTableColumnHeader<TData, TValue>({
  header
}: DataTableColumnHeaderProps<TData, TValue>) {
  const { column } = header;
  const { onSortChange } = useDataTable();

  const onSort = useCallback(
    (order: SortOrder) => {
      if (order === "asc") {
        column.toggleSorting(false);
      } else if (order === "desc") {
        column.toggleSorting(true);
      }

      if (onSortChange) {
        onSortChange(column.id, order);
      }
    },
    [column, onSortChange]
  );

  return (
    <TableCellRoot>
      <Box display="flex" alignItems="center" gap="4px">
        {flexRender(column.columnDef.header, header.getContext())}

        {column.getCanSort() && (
          <SortMenu column={column} onSortChange={onSort} />
        )}
      </Box>
    </TableCellRoot>
  );
}
