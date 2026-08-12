"use client";

import { Badge } from "~/components/ui/badge";
import { Spinner } from "~/components/ui/spinner";
import {
	buildCallTree,
	destinationTypeLabel,
	dispositionLabel,
	dispositionTone,
	flattenCallTree,
	formatBillsec,
	formatDuration,
	hangupCauseLabel,
	hangupCauseTone,
	recordingsForLeg,
} from "~/lib/cdr/format";
import { useCdrCall } from "../../_hooks/use-cdr-queries";
import { RecordingPlayer } from "../../recordings/_components/recording-player";
import type { CallLegRow } from "~/lib/cdr/contracts";

/**
 * Every leg of one call, drawn as the tree it is.
 *
 * A list row shows one LEG. The question a person actually has — "what happened to this call" — is
 * about the set: an inbound A-leg, the four B-legs a ring group originated for it, which of them
 * answered, and what cause the others ended with. Those relationships live in `originating_leg_id`
 * and `bridge_leg_id`, so this indents by parentage instead of listing five equal rows.
 *
 * The legs come from `/api/v1/cdr/calls/:callId` in ONE request, together with every recording any
 * of them produced, so the tree is never assembled from a half-loaded state.
 */
export function CallDetail({
	callId,
	range,
}: {
	callId: string;
	range: { readonly from?: string | undefined; readonly to?: string | undefined };
}) {
	const call = useCdrCall(callId, range);

	if (call.isPending) {
		return (
			<div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
				<Spinner className="size-3.5" label="Loading call legs" />
				Loading the rest of this call…
			</div>
		);
	}
	if (call.isError || !call.data) {
		return (
			<p className="px-4 py-3 text-xs text-muted-foreground">
				The other legs of this call could not be loaded. They may have fallen outside the selected
				time range, or been retired by the retention policy.
			</p>
		);
	}

	const nodes = flattenCallTree(buildCallTree(call.data.legs));

	return (
		<div className="flex flex-col gap-3 px-4 py-3">
			<p className="text-xs font-medium text-muted-foreground">
				{nodes.length === 1 ? "1 leg" : `${String(nodes.length)} legs`} in this call
			</p>

			<ol className="flex flex-col gap-2">
				{nodes.map((node) => (
					<CallLegLine
						key={node.leg.id}
						leg={node.leg}
						depth={node.depth}
						recordings={recordingsForLeg(call.data.recordings, node.leg.id)}
					/>
				))}
			</ol>
		</div>
	);
}

function CallLegLine({
	leg,
	depth,
	recordings,
}: {
	leg: CallLegRow;
	depth: number;
	recordings: ReturnType<typeof recordingsForLeg>;
}) {
	return (
		<li
			className="flex flex-col gap-1.5 rounded-md border border-border bg-surface/60 px-3 py-2"
			// Indentation is the only thing carrying parentage, so it is capped: past four levels the
			// row would be pushed off a narrow screen and the relationship stops being readable anyway.
			style={{ marginInlineStart: `${String(Math.min(depth, 4) * 1.25)}rem` }}
		>
			<div className="flex flex-wrap items-center gap-2">
				<Badge tone={leg.leg === "a" ? "accent" : "neutral"}>
					{leg.leg === "a" ? "A-leg" : "B-leg"}
				</Badge>
				<span className="font-mono text-xs">{leg.fromNumber}</span>
				<span aria-hidden="true" className="text-muted-foreground">
					→
				</span>
				<span className="font-mono text-xs">{leg.toNumber}</span>
				<Badge tone={dispositionTone(leg.disposition)}>{dispositionLabel(leg.disposition)}</Badge>
				<Badge tone={hangupCauseTone(leg.hangupCause)}>{hangupCauseLabel(leg.hangupCause)}</Badge>
			</div>

			<dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
				<Detail label="Started" value={new Date(leg.startedAt).toLocaleString()} />
				<Detail label="Duration" value={formatDuration(leg.durationMs)} />
				<Detail label="Billed" value={formatBillsec(leg.billsecMs)} />
				<Detail label="Went to" value={destinationTypeLabel(leg.destinationType)} />
				{leg.hangupSide === null ? null : <Detail label="Ended by" value={leg.hangupSide} />}
				{/*
				 * The numeric cause is shown alongside the name because it is the one that survives a
				 * carrier we have no name for: the writer stores an unknown cause as
				 * NORMAL_UNSPECIFIED and keeps the code verbatim, so the code is sometimes the only
				 * true thing in the pair.
				 */}
				<Detail label="Cause code" value={String(leg.hangupCauseCode)} />
				{/*
				 * The authorisation code that let this leg dial out, when one was demanded.
				 *
				 * `== null` and not a truthiness test: ordinal `0` is the FIRST code in a PIN set, and a
				 * falsy check would hide the one leg most likely to be somebody's shared front-desk code.
				 * It also covers the two absences at once — a leg where no code was demanded, and a leg
				 * read through a projection that does not carry the columns yet. See `CallLegRow`.
				 *
				 * The label may legitimately be null while the ordinal is not: an entry in a PIN set need
				 * not be named. "Authorised by code 3" is still the whole of what was recorded, and is
				 * enough to find the entry in the set.
				 */}
				{leg.authPinOrdinal == null ? null : (
					<Detail
						label="Authorised by"
						value={
							leg.authPinLabel == null
								? `code ${String(leg.authPinOrdinal)}`
								: `code ${String(leg.authPinOrdinal)} (${leg.authPinLabel})`
						}
					/>
				)}
			</dl>

			{recordings.length > 0 ? (
				<div className="flex flex-col gap-1.5 pt-1">
					{recordings.map((recording) => (
						<RecordingPlayer key={recording.id} recording={recording} compact />
					))}
				</div>
			) : null}
		</li>
	);
}

function Detail({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-baseline gap-1.5">
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="font-medium text-foreground" data-tabular>
				{value}
			</dd>
		</div>
	);
}
