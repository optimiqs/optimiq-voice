"use client";

import { useState } from "react";
import { ConfirmDialog } from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { LoadingPanel, Spinner } from "~/components/ui/spinner";
import {
	Table,
	TableBody,
	TableCell,
	TableContainer,
	TableHead,
	TableHeader,
	TableRow,
} from "~/components/ui/table";
import { toast } from "~/components/ui/toast";
import { CDR_EXPORT_MAX_ROWS, describeExportFilters } from "~/lib/cdr/client";
import { formatBytes } from "~/lib/cdr/format";
import {
	useCdrExportDownloadUrl,
	useCdrExportList,
	useDeleteCdrExport,
} from "../../_hooks/use-cdr-queries";
import type { CdrExportFailure, CdrExportRow, CdrExportStatus } from "~/lib/cdr/contracts";

/**
 * The export jobs, with the one that is running at the top.
 *
 * ## A failed job is the most informative row here, so it gets the most space
 *
 * `too-many-rows` is not a platform fault and must not read like one: it means the question was
 * wider than an export can answer, nothing was written, and the fix is in the requester's hands.
 * The other two failure reasons genuinely are ours, and saying which is which is the difference
 * between somebody narrowing their window and somebody opening a ticket.
 *
 * ## Download is a mutation, and the link is used immediately
 *
 * The URL is minted per click and expires in minutes, so it is never held in state and never
 * rendered as an `<a href>` somebody could copy: a link that works for ten minutes and then reads
 * as "the export is broken" is worse than a button that always works. The mint navigates straight
 * to the URL, which the API serves as an attachment.
 *
 * ## Expiry is shown on a succeeded job, because the file goes before the row does
 *
 * An export is a copy of the ledger sitting outside the ledger's own access controls, so the FILE
 * expires by default — the opposite of a recording, which is kept until a policy says otherwise. A
 * job whose window has closed still lists, with nothing to download, which is the honest rendering
 * of "this was produced and is gone".
 */

const STATUS_TONE: Readonly<Record<CdrExportStatus, "neutral" | "accent" | "success" | "danger">> =
	{
		queued: "neutral",
		running: "accent",
		succeeded: "success",
		failed: "danger",
	};

const STATUS_LABELS: Readonly<Record<CdrExportStatus, string>> = {
	queued: "Queued",
	running: "Running",
	succeeded: "Ready",
	failed: "Failed",
};

function failureLabel(reason: CdrExportFailure): string {
	if (reason === "too-many-rows") {
		return `More than ${CDR_EXPORT_MAX_ROWS.toLocaleString()} rows matched, so nothing was written — narrow the window or add a filter and try again.`;
	}
	if (reason === "storage") {
		return "The file could not be stored. Nothing was written; this one is on us — try again, and tell an administrator if it keeps happening.";
	}
	return "The export failed while it was running. Nothing was written; this one is on us.";
}

/** What a job asked for, in one line, for the row that is no longer on screen as filters. */
function askedFor(row: CdrExportRow): string {
	const filters = describeExportFilters(row.filters);
	const window = `${new Date(row.rangeFrom).toLocaleDateString()} – ${new Date(row.rangeTo).toLocaleDateString()}`;
	return filters.length === 0
		? window
		: `${window} · ${filters.map((entry) => `${entry.label}: ${entry.value}`).join(", ")}`;
}

export function CdrExportJobs() {
	const list = useCdrExportList({ limit: 10 });
	const download = useCdrExportDownloadUrl();
	const remove = useDeleteCdrExport();
	const [pendingDelete, setPendingDelete] = useState<CdrExportRow | null>(null);

	if (list.query.isPending) {
		return <LoadingPanel label="Loading exports" />;
	}

	if (list.rows.length === 0) {
		return (
			<p className="text-sm text-muted-foreground">
				No exports yet. Set the filters you want, then use Export to queue one — it runs in the
				background and appears here.
			</p>
		);
	}

	return (
		<>
			<TableContainer>
				<Table>
					<caption className="sr-only">Export jobs, newest first</caption>
					<TableHeader>
						<TableRow>
							<TableHead>Requested</TableHead>
							<TableHead>Asked for</TableHead>
							<TableHead>Status</TableHead>
							<TableHead className="text-right">Rows</TableHead>
							<TableHead className="text-right">Size</TableHead>
							<TableHead className="w-0">
								<span className="sr-only">Actions</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{list.rows.map((row) => {
							const label = typeof row.filters.label === "string" ? row.filters.label : null;
							return (
								<TableRow key={row.id}>
									<TableCell className="whitespace-nowrap align-top" data-tabular>
										{new Date(row.createdAt).toLocaleString()}
									</TableCell>
									<TableCell className="align-top">
										<div className="flex flex-col">
											{label ? <span className="text-sm text-foreground">{label}</span> : null}
											<span className="text-xs text-muted-foreground">{askedFor(row)}</span>
										</div>
									</TableCell>
									<TableCell className="align-top">
										<div className="flex flex-col gap-1">
											<span className="inline-flex items-center gap-1.5">
												<Badge tone={STATUS_TONE[row.status]}>{STATUS_LABELS[row.status]}</Badge>
												{/*
												 * A live region as well as a moving dot: the badge beside it is
												 * static text that this row replaces on the next poll, so a
												 * screen reader would otherwise get no signal that anything is
												 * being watched at all.
												 */}
												{row.status === "running" ? (
													<Spinner className="size-3" label="Still running" />
												) : null}
											</span>
											{row.failureReason === null ? null : (
												<span className="max-w-xs text-xs text-muted-foreground">
													{failureLabel(row.failureReason)}
												</span>
											)}
											{row.status === "succeeded" && row.objectKey === null ? (
												<span className="text-xs text-muted-foreground">
													The file has expired and been purged. The record of the request stays.
												</span>
											) : null}
											{row.status === "succeeded" && row.objectKey !== null && row.expiresAt ? (
												<span className="text-xs text-muted-foreground whitespace-nowrap">
													Available until {new Date(row.expiresAt).toLocaleDateString()}
												</span>
											) : null}
										</div>
									</TableCell>
									<TableCell className="text-right align-top whitespace-nowrap" data-tabular>
										{row.status === "succeeded" ? row.rowCount.toLocaleString() : "—"}
									</TableCell>
									<TableCell className="text-right align-top whitespace-nowrap" data-tabular>
										{row.status === "succeeded" && row.objectKey !== null
											? formatBytes(row.sizeBytes)
											: "—"}
									</TableCell>
									<TableCell className="text-right align-top whitespace-nowrap">
										<div className="flex justify-end gap-1">
											{row.status === "succeeded" && row.objectKey !== null ? (
												<Button
													size="sm"
													variant="secondary"
													loading={download.isPending && download.variables === row.id}
													onClick={() => {
														download.mutate(row.id, {
															onSuccess: (link) => {
																window.location.assign(link.url);
															},
															onError: () => {
																toast.error(
																	"That download link could not be created. The file may have expired.",
																);
															},
														});
													}}
												>
													Download
												</Button>
											) : null}
											<Button
												size="sm"
												variant="ghost"
												onClick={() => {
													remove.reset();
													setPendingDelete(row);
												}}
											>
												Delete
											</Button>
										</div>
									</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			</TableContainer>

			<ConfirmDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				title="Delete this export?"
				description="The file and the record of the request both go. The calls themselves are untouched — this only removes the copy that was extracted from them, which is the thing worth removing when you no longer need it."
				confirmLabel="Delete export"
				destructive
				pending={remove.isPending}
				onConfirm={() => {
					if (!pendingDelete) {
						return;
					}
					remove.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) });
				}}
			/>
		</>
	);
}
