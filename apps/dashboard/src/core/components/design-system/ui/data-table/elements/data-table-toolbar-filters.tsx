import { Box } from "@mui/material";
import { useDataTable } from "../data-table.context";
import { FilterSearch } from "./data-table-toolbar-filters-search";
import { FilterSearchBySelector } from "./data-table-toolbar-filters-search-by-selector";

export const DataTableToolbarFilters = () => {
	const { features, searchBy, searchableFields, onSearch, onSearchByFieldChange } = useDataTable();

	if (!features.includes("filters")) return null;

	return (
		<Box display="flex" alignItems="center" gap="12px">
			<FilterSearchBySelector
				searchBy={searchBy}
				searchableFields={searchableFields}
				onSearchByFieldChange={onSearchByFieldChange}
			/>
			<FilterSearch onSearchChange={onSearch} />
		</Box>
	);
};
