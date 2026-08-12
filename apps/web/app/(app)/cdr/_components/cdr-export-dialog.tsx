"use client";

import { useState } from "react";
import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { inputClassName } from "~/components/ui/field";
import {
	CDR_EXPORT_MAX_PENDING,
	CDR_EXPORT_MAX_RANGE_DAYS,
	CDR_EXPORT_MAX_ROWS,
	describeExportFilters,
	type CdrExportFilters,
} from "~/lib/cdr/client";
import { pbxFormMessage } from "~/lib/pbx/errors";
import { useCreateCdrExport } from "../../_hooks/use-cdr-queries";

/**
 * Queue an export of the filters currently on screen.
 *
 * ## It echoes the filters rather than offering its own
 *
 * The dialog takes the screen's query as a prop and shows it read-only. That is not laziness about
 * building a second filter form — it is the point of the feature: `createCdrExportDto` IS
 * `cdrListQuerySchema` minus the two paging fields, so the export means exactly what the list on
 * screen means, and a second set of controls would be a second place for the two to diverge.
 * Somebody who wants a different export changes the filters and reopens this.
 *
 * The one thing it adds is `label`, which is for the requester's own benefit and is never used as a
 * file name — the object key is derived from the job id, so no user input reaches a filesystem
 * path. The download's `content-disposition` carries the human-readable name instead.
 *
 * ## The bound is stated, and stated as a FAILURE
 *
 * An export that reaches {@link CDR_EXPORT_MAX_ROWS} rows fails; it does not truncate. Saying so
 * before somebody presses the button is the whole reason this copy exists: a truncated CSV is a
 * plausible-looking file with no marker saying where it stopped, and the honest alternative is a
 * job that refuses and tells the requester to narrow the window. A user who has not been told that
 * will read `failed` as a platform fault rather than as an answer they can act on.
 */
export function CdrExportDialog({
	open,
	onOpenChange,
	filters,
	rangeLabel,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The list's current query, minus the paging fields an export has no use for. */
	filters: CdrExportFilters;
	/** The window as the toolbar words it, so the dialog and the table agree on screen. */
	rangeLabel: string;
}) {
	const create = useCreateCdrExport();
	const [label, setLabel] = useState("");
	const described = describeExportFilters(filters as Readonly<Record<string, unknown>>);

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					create.reset();
					setLabel("");
				}
				onOpenChange(next);
			}}
		>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Export these calls</DialogTitle>
					<DialogDescription>
						The export runs in the background over exactly the filters below. It is a snapshot of
						this question asked now — re-running it later can produce a different file.
					</DialogDescription>
				</DialogHeader>

				<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-panel border border-border bg-muted/30 p-4 text-sm">
					<dt className="text-muted-foreground">Time range</dt>
					<dd className="text-foreground">{rangeLabel}</dd>
					{described.length === 0 ? (
						<>
							<dt className="text-muted-foreground">Filters</dt>
							<dd className="text-muted-foreground">
								None — every call in the range, which is the widest this can be.
							</dd>
						</>
					) : (
						described.map((entry) => (
							<div key={entry.label} className="col-span-2 grid grid-cols-subgrid">
								<dt className="text-muted-foreground">{entry.label}</dt>
								<dd className="text-foreground">{entry.value}</dd>
							</div>
						))
					)}
				</dl>

				<div className="flex flex-col gap-1.5">
					<label htmlFor="cdr-export-label" className="text-xs font-medium text-muted-foreground">
						Name this export
					</label>
					<input
						id="cdr-export-label"
						type="text"
						value={label}
						maxLength={128}
						onChange={(event) => setLabel(event.target.value)}
						placeholder="Q3 billing review"
						disabled={create.isPending}
						className={inputClassName}
					/>
					<p className="text-xs text-muted-foreground">
						Optional, and for your own benefit — it is not the file name. The downloaded file is
						named for the window it covers.
					</p>
				</div>

				<div className="space-y-2 text-xs text-muted-foreground">
					<p>
						<span className="font-medium text-foreground">
							An export is capped at about {CDR_EXPORT_MAX_ROWS.toLocaleString()} rows, and a job
							that reaches the cap FAILS rather than giving you part of the answer.
						</span>{" "}
						A truncated file looks complete and is not, so the platform refuses instead and asks you
						to narrow the window. If that happens, the job below says so and nothing was written.
					</p>
					<p>
						One export may cover up to {CDR_EXPORT_MAX_RANGE_DAYS} days — far wider than a list
						page, which is what this path is for — and this organization may have{" "}
						{CDR_EXPORT_MAX_PENDING} running at once.
					</p>
				</div>

				{create.error ? (
					<p role="alert" className="text-sm text-danger">
						{pbxFormMessage(create.error) ?? "This export could not be queued."}
					</p>
				) : null}

				<DialogFooter>
					<Button variant="secondary" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						variant="primary"
						loading={create.isPending}
						onClick={() => {
							create.mutate(
								{
									...filters,
									...(label.trim().length > 0 ? { label: label.trim() } : {}),
								},
								{
									onSuccess: () => {
										setLabel("");
										onOpenChange(false);
									},
								},
							);
						}}
					>
						Queue export
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
