"use client";

import { parseAsInteger, parseAsStringLiteral, useQueryState } from "nuqs";
import { useId, useState } from "react";
import { ListPagination } from "~/components/pbx/resource-list";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "~/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { EmptyState } from "~/components/ui/empty-state";
import { inputClassName, Textarea } from "~/components/ui/field";
import { BuildingIcon } from "~/components/ui/icons";
import { PageHeader } from "~/components/ui/page-header";
import { LoadingPanel } from "~/components/ui/spinner";
import {
	Table,
	TableBody,
	TableCell,
	TableContainer,
	TableHead,
	TableHeader,
	TableRow,
} from "~/components/ui/table";
import { cn } from "~/lib/cn";
import { KYC_DECISIONS } from "~/lib/pbx/contracts";
import {
	KYC_DECISION_LABELS,
	KYC_DECISION_TONES,
	REVIEWER_DECISIONS,
	decisionNoteIssue,
	type PlatformKycEntry,
	type ReviewerDecision,
} from "~/lib/platform/contracts";
import { useKycDecision, usePlatformKycQueue } from "../../../_hooks/use-platform-queries";

/**
 * The platform operator's KYC review queue — every tenant's file, oldest-waiting first.
 *
 * ## Why this screen exists at all
 *
 * `compliance.review` had an API and no UI: a decision could only be recorded with a `POST` from a
 * terminal. The FCC's KYC/KYUP expectations are that an originating provider knows who its customer
 * is BEFORE it carries their traffic, and `compliance.requireKycForOutbound` turns that into a hard
 * refusal at the outbound seam — which means the review queue is on the critical path for a tenant
 * being able to make a call at all. A surface that only an engineer can operate is not a review
 * process.
 *
 * ## The tax id is not here, and there is no control that could reveal it
 *
 * `organization_kyc.tax_id` is envelope-encrypted and the read projection does not name the column,
 * so no response this screen can make carries it. `taxIdLast4` is rendered instead, which is what a
 * reviewer actually uses: enough to match the document a tenant emailed them, and not enough to be
 * worth exfiltrating. The absence is structural — see `kyc.repository.ts` — rather than a decision
 * this component makes, which is why there is no "reveal" affordance to be tempted by later.
 *
 * ## Rows expand rather than link
 *
 * There is no `GET /platform/compliance/kyc/:id`; the list row IS the file. So the detail is an
 * expansion of what the row already carries, exactly as the audit log renders its diff — a second
 * request would be a second endpoint for data already on the page, and every read of this surface
 * writes an audit row, so it would also be a second entry in the ledger for one act of reading.
 */
const DECISION_FILTERS = ["", ...KYC_DECISIONS] as const;

const REVIEWER_DECISION_LABELS: Readonly<Record<ReviewerDecision, string>> = {
	approved: "Approve",
	"needs-info": "Ask for more",
	rejected: "Reject",
};

export function PlatformKycScreen() {
	const filterId = useId();

	const [decision, setDecision] = useQueryState(
		"decision",
		parseAsStringLiteral(DECISION_FILTERS)
			.withDefault("pending")
			.withOptions({ clearOnDefault: false }),
	);
	const [page, setPage] = useQueryState(
		"page",
		parseAsInteger.withDefault(1).withOptions({ clearOnDefault: true }),
	);

	const queue = usePlatformKycQueue({
		decision: decision === "" ? undefined : decision,
		page,
		limit: 25,
	});

	const [expanded, setExpanded] = useState<string | null>(null);
	const [reviewing, setReviewing] = useState<PlatformKycEntry | null>(null);

	const rows = queue.data?.data ?? [];

	return (
		<>
			<PageHeader
				title="KYC review"
				description="Every organization's know-your-customer file, across all tenants. Approving one is what lets its outbound calls claim an attestation; refusing one is what stops them."
			/>

			<div className="flex flex-wrap items-end gap-3">
				<div className="flex flex-col gap-1.5">
					<label htmlFor={filterId} className="text-xs font-medium text-muted-foreground">
						Decision
					</label>
					<select
						id={filterId}
						value={decision}
						onChange={(event) => {
							void setDecision(event.target.value as (typeof DECISION_FILTERS)[number]);
							void setPage(1);
							setExpanded(null);
						}}
						className={cn(inputClassName, "w-56 pr-8")}
					>
						<option value="">Every file</option>
						{KYC_DECISIONS.map((value) => (
							<option key={value} value={value}>
								{KYC_DECISION_LABELS[value]}
							</option>
						))}
					</select>
				</div>
			</div>

			{queue.isPending ? (
				<LoadingPanel label="Loading the review queue" />
			) : rows.length === 0 ? (
				<EmptyState
					icon={<BuildingIcon className="size-5" />}
					title={decision === "" ? "No files yet" : "Nothing waiting here"}
					description={
						decision === ""
							? "No organization has submitted a know-your-customer record. A tenant files one from their own compliance page."
							: "No file has this decision. Switch the filter to see the rest of the queue."
					}
				/>
			) : (
				<>
					<TableContainer>
						<Table>
							<caption className="sr-only">Know-your-customer files awaiting review</caption>
							<TableHeader>
								<TableRow>
									<TableHead>Organization</TableHead>
									<TableHead>Legal entity</TableHead>
									<TableHead>Tax ID</TableHead>
									<TableHead>Decision</TableHead>
									<TableHead>Submitted</TableHead>
									<TableHead className="w-0">
										<span className="sr-only">Actions</span>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{rows.map((row) => (
									<KycRow
										key={row.id}
										row={row}
										expanded={expanded === row.id}
										onToggle={() => setExpanded(expanded === row.id ? null : row.id)}
										onReview={() => setReviewing(row)}
									/>
								))}
							</TableBody>
						</Table>
					</TableContainer>

					<ListPagination
						page={queue.data?.page ?? 1}
						limit={queue.data?.limit ?? 25}
						total={queue.data?.total ?? 0}
						totalPages={Math.max(
							1,
							Math.ceil((queue.data?.total ?? 0) / (queue.data?.limit ?? 25)),
						)}
						onPageChange={(next) => {
							void setPage(next);
							setExpanded(null);
						}}
					/>
				</>
			)}

			<p className="text-xs text-muted-foreground">
				Reading this queue and recording a decision are both written to the change ledger — a
				listing under your own organization, a verdict under the organization it was about. The
				stored tax identifier is encrypted and is never returned by the API; only its last four
				digits appear here.
			</p>

			<ReviewDialog entry={reviewing} onClose={() => setReviewing(null)} />
		</>
	);
}

function KycRow({
	row,
	expanded,
	onToggle,
	onReview,
}: {
	row: PlatformKycEntry;
	expanded: boolean;
	onToggle: () => void;
	onReview: () => void;
}) {
	return (
		<>
			<TableRow>
				<TableCell className="text-sm text-foreground">
					{row.organizationName ?? "—"}
					<span
						title={row.organizationId}
						className="block font-mono text-xs text-muted-foreground"
					>
						{row.organizationId.slice(0, 8)}…
					</span>
				</TableCell>
				<TableCell className="text-sm">{row.legalEntityName}</TableCell>
				<TableCell className="font-mono text-sm" data-tabular>
					{row.taxIdLast4 === null ? "—" : `••••${row.taxIdLast4}`}
				</TableCell>
				<TableCell>
					<Badge tone={KYC_DECISION_TONES[row.decision]}>{KYC_DECISION_LABELS[row.decision]}</Badge>
				</TableCell>
				<TableCell className="whitespace-nowrap text-sm text-muted-foreground" data-tabular>
					{new Date(row.updatedAt).toLocaleString()}
				</TableCell>
				<TableCell className="text-right whitespace-nowrap">
					<div className="flex justify-end gap-1">
						<Button size="sm" variant="ghost" aria-expanded={expanded} onClick={onToggle}>
							{expanded ? "Hide file" : "View file"}
						</Button>
						<Button size="sm" variant="primary" onClick={onReview}>
							Decide
						</Button>
					</div>
				</TableCell>
			</TableRow>
			{expanded ? (
				<TableRow>
					<TableCell colSpan={6} className="bg-muted/30">
						<KycDetail row={row} />
					</TableCell>
				</TableRow>
			) : null}
		</>
	);
}

function KycDetail({ row }: { row: PlatformKycEntry }) {
	const address = [
		row.addressLine1,
		row.addressLine2,
		`${row.addressCity}, ${row.addressRegion} ${row.addressPostalCode}`,
		row.addressCountry,
	]
		.filter((part) => part !== null && part.trim().length > 0)
		.join(" · ");

	return (
		<div className="grid gap-4 py-2 sm:grid-cols-2">
			<Card>
				<CardHeader>
					<CardTitle>The entity</CardTitle>
				</CardHeader>
				<CardBody className="grid gap-1 text-sm">
					<DetailRow label="Legal name" value={row.legalEntityName} />
					<DetailRow label="Type" value={row.entityType} />
					<DetailRow
						label="Tax ID"
						value={row.taxIdLast4 === null ? "none on file" : `ends ${row.taxIdLast4}`}
					/>
					<DetailRow label="Registered address" value={address} />
					<DetailRow label="Website" value={row.websiteUrl} />
				</CardBody>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle>Contact and traffic</CardTitle>
				</CardHeader>
				<CardBody className="grid gap-1 text-sm">
					<DetailRow label="Authorised contact" value={row.contactName} />
					<DetailRow label="Email" value={row.contactEmail} />
					<DetailRow label="Phone" value={row.contactPhone} />
					<DetailRow label="Traffic profile" value={row.expectedTrafficProfile} />
					<DetailRow
						label="Expected minutes"
						value={
							row.expectedMonthlyMinutes === null
								? null
								: row.expectedMonthlyMinutes.toLocaleString()
						}
					/>
					<DetailRow
						label="Last decision"
						value={
							row.reviewedAt === null
								? "never reviewed"
								: `${KYC_DECISION_LABELS[row.decision]} on ${new Date(row.reviewedAt).toLocaleString()}`
						}
					/>
					<DetailRow label="Reviewer note" value={row.reviewNotes} />
				</CardBody>
			</Card>
		</div>
	);
}

function DetailRow({ label, value }: { label: string; value: string | null }) {
	return (
		<div className="flex gap-2">
			<span className="w-40 shrink-0 text-xs text-muted-foreground">{label}</span>
			<span className="text-foreground">{value === null || value.length === 0 ? "—" : value}</span>
		</div>
	);
}

/**
 * The verdict, with its note.
 *
 * A `Dialog` and not `ConfirmDialog`: that component's own header says it is "confirmation only,
 * never a form", and this is a form — the note is the substance of two of the three decisions. The
 * nudge for a missing note is client-side and deliberate; the server accepts a note-less rejection
 * and says why (a schema refusal would only teach reviewers to type "no").
 */
function ReviewDialog({ entry, onClose }: { entry: PlatformKycEntry | null; onClose: () => void }) {
	const decide = useKycDecision();
	const [decision, setDecision] = useState<ReviewerDecision>("approved");
	const [notes, setNotes] = useState("");
	const [showIssue, setShowIssue] = useState(false);
	const decisionId = useId();
	const notesId = useId();

	const issue = decisionNoteIssue(decision, notes);

	return (
		<Dialog
			open={entry !== null}
			onOpenChange={(open) => {
				if (!open) {
					setDecision("approved");
					setNotes("");
					setShowIssue(false);
					onClose();
				}
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Record a decision</DialogTitle>
					<DialogDescription>
						{entry === null
							? ""
							: `${entry.organizationName ?? entry.legalEntityName} — the tenant sees the verdict and your note on their own compliance page.`}
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-4">
					<div className="flex flex-col gap-1.5">
						<label htmlFor={decisionId} className="text-xs font-medium text-muted-foreground">
							Decision
						</label>
						<select
							id={decisionId}
							value={decision}
							onChange={(event) => setDecision(event.target.value as ReviewerDecision)}
							className={cn(inputClassName, "pr-8")}
						>
							{REVIEWER_DECISIONS.map((value) => (
								<option key={value} value={value}>
									{REVIEWER_DECISION_LABELS[value]}
								</option>
							))}
						</select>
					</div>

					<div className="flex flex-col gap-1.5">
						<label htmlFor={notesId} className="text-xs font-medium text-muted-foreground">
							Note to the tenant
						</label>
						<Textarea
							id={notesId}
							rows={4}
							value={notes}
							onChange={(event) => setNotes(event.target.value)}
							placeholder="What you checked, or what is still missing."
						/>
						{showIssue && issue !== undefined ? (
							<p role="alert" className="text-xs text-danger">
								{issue}
							</p>
						) : null}
					</div>
				</div>

				<DialogFooter>
					<Button variant="ghost" onClick={onClose}>
						Cancel
					</Button>
					<Button
						variant={decision === "rejected" ? "danger" : "primary"}
						loading={decide.isPending}
						onClick={() => {
							if (entry === null) {
								return;
							}
							if (issue !== undefined) {
								setShowIssue(true);
								return;
							}
							decide.mutate(
								{
									organizationId: entry.organizationId,
									input: {
										decision,
										reviewNotes: notes.trim().length > 0 ? notes.trim() : null,
									},
								},
								{ onSuccess: () => onClose() },
							);
						}}
					>
						{REVIEWER_DECISION_LABELS[decision]}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
