import { createContext, useCallback, useContext } from "react";
import { useTable } from "./use-table";
import type {
  DataTableContextProps,
  DataTableContextProviderProps
} from "./data-table.interfaces";

export const DataTableContext =
  createContext<DataTableContextProps<any> | null>(null);

export const DataTableProvider = <T,>({
  data,
  columns,
  features,
  getRowId,
  onDeleteSelected,
  onEditSelected,
  onRowClick,
  children,
  ...rest
}: DataTableContextProviderProps<T>) => {
  const { table, selectedRows } = useTable({
    data,
    columns,
    features,
    getRowId
  });

  const onDeleteChanged = useCallback(() => {
    if (onDeleteSelected) {
      onDeleteSelected(selectedRows);
    }
  }, [onDeleteSelected, selectedRows]);

  const onEditChanged = useCallback(() => {
    if (onEditSelected && selectedRows.length === 1) {
      onEditSelected(selectedRows[0]);
    }
  }, [onEditSelected, selectedRows]);

  return (
    <DataTableContext.Provider
      value={{
        ...rest,
        onDeleteSelected: onDeleteSelected ? onDeleteChanged : undefined,
        onEditSelected: onEditSelected ? onEditChanged : undefined,
        onRowClick,
        table,
        columns,
        features,
        getRowId,
        selectedRows
      }}
    >
      {children}
    </DataTableContext.Provider>
  );
};

export const useDataTable = () => {
  const context = useContext(DataTableContext);

  if (!context) {
    throw new Error(
      "useDataTable() must be used within a <DataTableProvider />"
    );
  }

  return context;
};
