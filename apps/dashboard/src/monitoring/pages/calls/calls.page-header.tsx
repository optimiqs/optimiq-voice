import { mkConfig, generateCsv, download } from "export-to-csv";
import { useCallback } from "react";
import { Button } from "~/core/components/design-system/ui/button/button";
import { toast } from "~/core/components/design-system/ui/toaster/toaster";
import { PageHeader } from "~/core/components/general/page/page-header";
import type { CallDetailRecord } from "@optimiq-voice/types";

/**
 * CSV export configuration for call logs.
 *
 * Defines:
 * - Field separator
 * - Decimal separator
 * - Use of keys as headers
 * - Output filename
 */
const csvConfig = mkConfig({
  fieldSeparator: ",",
  decimalSeparator: ".",
  useKeysAsHeaders: true,
  filename: "optimiq-voice-call-logs"
});

/**
 * CallsPageHeader component.
 *
 * Renders the page header for the Voice Calls page, including:
 * - Title and description
 * - A button to export call logs as a CSV file
 *
 * @param {CallDetailRecord[]} data - The call logs data to display and export.
 * @param {boolean} isLoading - Indicates whether the data is still loading.
 * @returns {JSX.Element} The rendered page header component.
 */
export function CallsPageHeader({
  data,
  isLoading
}: {
  data: CallDetailRecord[];
  isLoading: boolean;
}) {
  /**
   * Handles exporting the call logs as a CSV file.
   *
   * - Normalizes date fields to ISO strings.
   * - Generates a CSV using the configured options.
   * - Initiates download of the generated CSV file.
   * - Displays a toast if there are no call logs to export.
   */
  const handleExportData = useCallback(() => {
    if (!data || data.length === 0) {
      toast(
        "Oops! No call logs to export. Start making calls to generate logs."
      );
      return;
    }

    // Normalize date fields to ISO strings to ensure consistency in the exported CSV.
    const normalizedData = data.map((record) => ({
      ...record,
      startedAt:
        record.startedAt instanceof Date
          ? record.startedAt.toISOString()
          : record.startedAt,
      endedAt:
        record.endedAt instanceof Date
          ? record.endedAt.toISOString()
          : record.endedAt
    }));

    // Generate and download the CSV file.
    const csv = generateCsv(csvConfig)(normalizedData);
    download(csvConfig)(csv);
  }, [data]);

  /**
   * Renders the page header component.
   */
  return (
    <PageHeader
      title="Monitoring / Call Logs"
      description="View and inspect call logs generated in this workspace."
      actions={
        <Button
          variant="outlined"
          size="small"
          onClick={handleExportData}
          disabled={isLoading}
        >
          {isLoading ? "Loading calls..." : "Export to CSV"}
        </Button>
      }
    />
  );
}
