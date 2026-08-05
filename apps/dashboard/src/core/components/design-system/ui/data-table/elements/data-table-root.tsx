import { useDataTable } from "../data-table.context";
import { DataTableBody } from "./data-table-body";
import { DataTableHead } from "./data-table-head";
import { DataTableToolbar } from "./data-table-toolbar";
import { DataTableContainerElement, DataTableRootElement, TableRoot } from "./data-table.styles";

export function DataTableRoot() {
	const { table, features, variant = "default" } = useDataTable();

	return (
		<DataTableRootElement>
			<DataTableToolbar />

			<DataTableContainerElement data-variant={variant}>
				<TableRoot>
					<colgroup>
						{features.includes("selection") && <col style={{ width: "48px" }} />}
						{table.getAllColumns().map((column) => (
							<col key={column.id} />
						))}
					</colgroup>
					<DataTableHead />
					<DataTableBody />
				</TableRoot>
			</DataTableContainerElement>
		</DataTableRootElement>
	);
}
