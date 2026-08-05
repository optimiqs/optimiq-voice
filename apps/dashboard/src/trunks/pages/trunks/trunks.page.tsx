import { useCallback, useState } from "react";
import { useNavigate } from "react-router";
import { DataTable } from "~/core/components/design-system/ui/data-table/data-table";
import { Page } from "~/core/components/general/page/page";
import { useResourceTable } from "~/core/hooks/use-resource-table";
import { PAGE_SIZE } from "~/core/shared/page-sizes.const";
import { useWorkspaceId } from "~/workspaces/hooks/use-workspace-id";
import { useTrunks, useDeleteTrunk } from "../../services/trunks.service";
import { columns } from "./trunks.columns";
import { TRUNKS_SEARCHABLE_FIELDS } from "./trunks.const";
import { TrunksPageHeader } from "./trunks.page-header";
import type { Route } from "./+types/trunks.page";
import type { Trunk } from "@optimiq-voice/types";

/**
 * Page metadata function for the Trunks page.
 *
 * Sets the page title and meta description for SEO and browser display.
 *
 * @param _ - Meta arguments provided by the router (not used here).
 * @returns An array of metadata objects for the page.
 */
export function meta(_: Route.MetaArgs) {
	return [
		{ title: "Trunks | Optimiq Voice" },
		{
			name: "description",
			content: "Configure your VoIP providers to enable inbound and outbound PSTN calls.",
		},
	];
}

/**
 * Trunks page component.
 *
 * Renders a table of phone trunks with search, pagination, deletion, and editing features.
 * Uses a reusable DataTable component for consistent design and behavior.
 *
 * @returns {JSX.Element} The rendered Trunks page.
 */
export default function TrunksList() {
	/** Hook to navigate programmatically within the application. */
	const navigate = useNavigate();

	/** Retrieves the current workspace ID for API calls and navigation. */
	const workspaceId = useWorkspaceId();

	/** State to hold the current pagination token used to fetch a specific page of data. */
	const [pageToken, setPageToken] = useState<string | undefined>(undefined);

	/** Fetch trunks data using the current page token and page size. */
	const { data, nextPageToken, isLoading } = useTrunks({
		pageSize: PAGE_SIZE,
		pageToken,
	});

	/** Hook to delete a trunk via the API. */
	const { mutate: deleteTrunk } = useDeleteTrunk();

	/**
	 * Custom hook for table management:
	 * - Handles search functionality
	 * - Handles pagination (next/prev pages)
	 * - Handles deletion of selected rows
	 * - Integrates with UI components
	 */
	const {
		filteredData,
		searchBy,
		setSearchBy,
		handleNextPage,
		handlePrevPage,
		handleSearch,
		handleDelete,
		prevTokens,
	} = useResourceTable({
		data,
		pageSize: PAGE_SIZE,
		pageToken,
		setPageToken,
		deleteResource: deleteTrunk,
		searchableFields: TRUNKS_SEARCHABLE_FIELDS,
		defaultSearchBy: "name",
	});

	/**
	 * Callback function to handle editing a selected trunk.
	 *
	 * Navigates to the edit page for the selected trunk.
	 * Uses view transitions for a smoother user experience.
	 * @param ref - The reference of the trunk to edit.
	 * @param {ITrunk} ref - The trunk object containing the reference.
	 * @returns {void}
	 */
	const onEditSelected = useCallback(({ ref }: Trunk) => {
		navigate(`/workspaces/${workspaceId}/sip-network/trunks/${ref}/edit`, {
			viewTransition: true,
		});
	}, []);

	/**
	 * Renders the Trunks page, including a header and a DataTable.
	 */
	return (
		<Page>
			<TrunksPageHeader />

			<DataTable
				/** Indicates loading state during data fetch. */
				isLoading={isLoading}
				/** Data displayed in the table, filtered by search input. */
				data={filteredData}
				/** Column definitions for each table column. */
				columns={columns}
				/** Function to determine the unique row ID for each record. */
				getRowId={(row) => row.ref}
				/** The currently selected search field (e.g., "ref", "name"). */
				searchBy={searchBy}
				/** List of available searchable fields presented to the user. */
				searchableFields={TRUNKS_SEARCHABLE_FIELDS}
				/** Trunk of rows displayed per page. */
				pageSize={PAGE_SIZE}
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
				/** Handler for updating the search input. */
				onSearch={handleSearch}
				/** Handler for changing the search field selection. */
				onSearchByFieldChange={setSearchBy}
				/** Handler for deleting selected rows. */
				onDeleteSelected={handleDelete}
				/** Handler for editing selected rows (currently shows a toast). */
				onEditSelected={onEditSelected}
				/** Handler for clicking on a row to navigate to edit page. */
				onRowClick={onEditSelected}
			/>
		</Page>
	);
}
