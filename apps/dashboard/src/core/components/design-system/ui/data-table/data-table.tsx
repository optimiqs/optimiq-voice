import { DATA_TABLE_FEATURES } from "./data-table.const";
import { DataTableProvider } from "./data-table.context";
import { DataTableRoot } from "./elements/data-table-root";
import type { DataTableProps } from "./data-table.interfaces";

export function DataTable<T>(props: DataTableProps<T>) {
  return (
    <DataTableProvider {...{ features: DATA_TABLE_FEATURES, ...props }}>
      <DataTableRoot />
    </DataTableProvider>
  );
}
