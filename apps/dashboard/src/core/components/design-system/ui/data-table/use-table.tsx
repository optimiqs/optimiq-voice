import {
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type RowSelectionState,
  type SortingState
} from "@tanstack/react-table";
import { useState } from "react";
import { DATA_TABLE_FEATURES } from "./data-table.const";
import type { UseDataTable } from "./data-table.interfaces";

export function useTable<T>({
  data,
  columns,
  features = DATA_TABLE_FEATURES,
  getRowId
}: UseDataTable<T>) {
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [sorting, setSorting] = useState<SortingState>([]);

  const table = useReactTable({
    state: {
      rowSelection,
      sorting
    },
    data,
    columns,
    getRowId,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableRowSelection: features.includes("selection"),
    onRowSelectionChange: setRowSelection,
    onSortingChange: setSorting
  });

  const selectedRows = table.getSelectedRowModel().rows.map((r) => r.original);

  return {
    selectedRows,
    table,
    rowSelection,
    sorting,
    setRowSelection,
    setSorting
  };
}
