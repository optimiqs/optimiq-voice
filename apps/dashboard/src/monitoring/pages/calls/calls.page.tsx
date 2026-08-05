import { useState } from "react";
import { DataTable } from "~/core/components/design-system/ui/data-table/data-table";
import { Page } from "~/core/components/general/page/page";
import { useResourceTable } from "~/core/hooks/use-resource-table";
import { CALLS_PAGE_SIZE } from "~/core/shared/page-sizes.const";
import { useCalls } from "../../services/calls.service";
import { columns } from "./calls.columns";
import { CALLS_SEARCHABLE_FIELDS } from "./calls.const";
import { CallsPageHeader } from "./calls.page-header";
import type { Route } from "./+types/calls.page";

/**
 * Page metadata function for the Calls page.
 *
 * Sets the page title and meta description for SEO and browser display.
 *
 * @param _ - Meta arguments provided by the router (not used here).
 * @returns An array of metadata objects for the page.
 */
export function meta(_: Route.MetaArgs) {
	return [
		{ title: "Monitoring / Call Logs" },
		{
			name: "description",
			content: "View and inspect call logs generated in this workspace.",
		},
	];
}

/**
 * Calls page component.
 *
 * Renders a table of phone calls with search, pagination, and filtering features.
 * Uses a reusable DataTable component for consistent design and behavior.
 *
 * @returns {JSX.Element} The rendered Calls page.
 */
export default function Calls() {
	/**
	 * State to hold the current pagination token used to fetch a specific page of data.
	 * This enables infinite scrolling or pagination without resetting the entire table state.
	 */
	const [pageToken, setPageToken] = useState<string | undefined>(undefined);

	/**
	 * Fetches calls data using the current page token and page size.
	 *
	 * @returns {Object} Contains:
	 *  - data: The fetched call records.
	 *  - nextPageToken: The token for fetching the next page.
	 *  - isLoading: Indicates if the data is still loading.
	 */
	const { data, nextPageToken, isLoading } = useCalls({
		pageSize: CALLS_PAGE_SIZE,
		pageToken,
	});

	/**
	 * Custom hook for table management:
	 * - Handles search functionality
	 * - Handles pagination (next/prev pages)
	 * - Integrates with UI components for consistent UX.
	 */
	const {
		filteredData,
		searchBy,
		setSearchBy,
		handleNextPage,
		handlePrevPage,
		handleSearch,
		prevTokens,
	} = useResourceTable({
		data,
		pageSize: CALLS_PAGE_SIZE,
		pageToken,
		setPageToken,
		searchableFields: CALLS_SEARCHABLE_FIELDS,
		defaultSearchBy: "from",
	});

	/**
	 * Renders the Calls page layout, including the header and the DataTable.
	 */
	return (
		<Page>
			{/* Header with title, description, and export functionality */}
			<CallsPageHeader data={data} isLoading={isLoading} />

			{/* DataTable with calls data and search/filter/pagination controls */}
			<DataTable
				/** Indicates loading state while data is being fetched. */
				isLoading={isLoading}
				/** Data displayed in the table, filtered by the search term. */
				data={filteredData}
				/** Column definitions for each table column. */
				columns={columns}
				/** Function to determine the unique row ID for each record. */
				getRowId={(row) => row.ref}
				/** The currently selected search field. */
				searchBy={searchBy}
				/** List of available searchable fields presented to the user. */
				searchableFields={CALLS_SEARCHABLE_FIELDS}
				/** Number of rows displayed per page. */
				pageSize={CALLS_PAGE_SIZE}
				/** Pagination configuration: total rows, next and previous tokens. */
				pagination={{
					total: filteredData.length,
					nextToken: nextPageToken,
					prevToken: prevTokens.length ? prevTokens[prevTokens.length - 1] : null,
				}}
				/** Handler for navigating to the next page. */
				onNextPage={() => handleNextPage(nextPageToken)}
				/** Handler for navigating to the previous page. */
				onPrevPage={handlePrevPage}
				/** Handler for updating the search term. */
				onSearch={handleSearch}
				/** Handler for changing the search field selection. */
				onSearchByFieldChange={setSearchBy}
				/** Features enabled in the table, such as filters and pagination. */
				features={["filters", "pagination"]}
			/>
		</Page>
	);
}
