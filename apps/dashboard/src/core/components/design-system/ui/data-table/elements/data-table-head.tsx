import { TableCell, TableHead, TableRow } from "@mui/material";
import { useDataTable } from "../data-table.context";
import { DataTableColumnHeader } from "./data-table-column-header";

export function DataTableHead() {
	const { table, features } = useDataTable();

	return (
		<TableHead>
			<TableRow>
				{features.includes("selection") && <TableCell data-selection-cell="true" />}
				{table
					.getHeaderGroups()
					.map((group) =>
						group.headers.map((header) => (
							<DataTableColumnHeader key={header.id} header={header} />
						)),
					)}
			</TableRow>
		</TableHead>
	);
}
