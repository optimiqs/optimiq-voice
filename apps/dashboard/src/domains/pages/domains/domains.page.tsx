import { useCallback, useState } from "react";
import { useNavigate } from "react-router";
import { DataTable } from "~/core/components/design-system/ui/data-table/data-table";
import { Page } from "~/core/components/general/page/page";
import { useResourceTable } from "~/core/hooks/use-resource-table";
import { PAGE_SIZE } from "~/core/shared/page-sizes.const";
import { useWorkspaceId } from "~/workspaces/hooks/use-workspace-id";
import { useDomains, useDeleteDomain } from "../../services/domains.service";
import { columns } from "./domains.columns";
import { DOMAINS_SEARCHABLE_FIELDS } from "./domains.const";
import { DomainsPageHeader } from "./domains.page-header";
import type { Route } from "./+types/domains.page";
import type { Domain } from "@optimiq-voice/types";

/**
 * Page metadata function for the Domains page.
 *
 * Sets the page title and meta description for SEO and browser display.
 *
 * @param _ - Meta arguments provided by the router (not used here).
 * @returns An array of metadata objects for the page.
 */
export function meta(_: Route.MetaArgs) {
  return [
    { title: "Domains | Optimiq Voice" },
    {
      name: "description",
      content:
        "Group SIP Agents under a domain (e.g., office, home) to simplify internal VoIP routing."
    }
  ];
}

/**
 * Domains page component.
 *
 * Renders a table of phone domains with search, pagination, deletion, and editing features.
 * Uses a reusable DataTable component for consistent design and behavior.
 *
 * @returns {JSX.Element} The rendered Domains page.
 */
export default function DomainsList() {
  /** Hook to navigate programmatically within the application. */
  const navigate = useNavigate();

  /** Retrieves the current workspace ID for API calls and navigation. */
  const workspaceId = useWorkspaceId();

  /** State to hold the current pagination token used to fetch a specific page of data. */
  const [pageToken, setPageToken] = useState<string | undefined>(undefined);

  /** Fetch domains data using the current page token and page size. */
  const { data, nextPageToken, isLoading } = useDomains({
    pageSize: PAGE_SIZE,
    pageToken
  });

  /** Hook to delete a domain via the API. */
  const { mutate: deleteDomain } = useDeleteDomain();

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
    prevTokens
  } = useResourceTable({
    data,
    pageSize: PAGE_SIZE,
    pageToken,
    setPageToken,
    deleteResource: deleteDomain,
    searchableFields: DOMAINS_SEARCHABLE_FIELDS,
    defaultSearchBy: "name"
  });

  /**
   * Callback function to handle editing a selected domain.
   *
   * Navigates to the edit page for the selected domain.
   * Uses view transitions for a smoother user experience.
   * @param ref - The reference of the domain to edit.
   * @param {IDomain} ref - The domain object containing the reference.
   * @returns {void}
   */
  const onEditSelected = useCallback(({ ref }: Domain) => {
    navigate(`/workspaces/${workspaceId}/sip-network/domains/${ref}/edit`, {
      viewTransition: true
    });
  }, []);

  /**
   * Renders the Domains page, including a header and a DataTable.
   */
  return (
    <Page>
      <DomainsPageHeader />

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
        searchableFields={DOMAINS_SEARCHABLE_FIELDS}
        /** Domain of rows displayed per page. */
        pageSize={PAGE_SIZE}
        /** Pagination configuration: total rows, next and previous tokens. */
        pagination={{
          total: filteredData.length,
          nextToken: nextPageToken,
          prevToken: prevTokens.length
            ? prevTokens[prevTokens.length - 1]
            : null
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
