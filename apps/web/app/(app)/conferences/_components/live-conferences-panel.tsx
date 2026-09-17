"use client";

import { useState } from "react";
import { ConfirmDialog } from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "~/components/ui/card";
import { EmptyState } from "~/components/ui/empty-state";
import { LoadingPanel } from "~/components/ui/spinner";
import { formatDuration } from "~/lib/cdr/format";
import { CONFERENCE_UNITY_GAIN_PERCENT, type LiveConferenceParticipant } from "~/lib/live/store";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { usePermission } from "../../_context/session-context";
import {
	conferenceTargetKey,
	useConferenceModeration,
} from "../../_hooks/use-conference-moderation";
import { useLiveActiveCalls, useLiveConferences } from "../../_hooks/use-live-queries";
import { usePbxList } from "../../_hooks/use-pbx-queries";
import type { LiveConferenceRoomView } from "~/lib/live/store";
import type { ConferenceRow } from "~/lib/pbx/contracts";

/**
 * The meetings that are happening, and the controls that act on them.
 *
 * ## Watching and moderating are separate grants, and the panel honours that per control
 *
 * Everything visible here rides `conferences.read`, which is the page's own floor. The ACTIONS ride
 * `conferences.moderate`, which the API checks in the service rather than on the route decorator —
 * so a watcher gets a 403 that says "you can see the room and cannot act on it", not "you cannot
 * reach this surface". The buttons are therefore rendered INERT rather than hidden, on the wallboard
 * precedent: a supervisor who can see that a room is locked and cannot unlock it still needs to know
 * it, because the next thing they do is telephone somebody.
 *
 * ## The participant list may be incomplete, and says so
 *
 * The rooms come from the `conference-claims` bucket and arrive complete in one snapshot; the
 * PEOPLE come from `conference.joined` / `left` / `participant.updated`, which only describe what
 * has moved since this tab connected. A console opened mid-meeting therefore knows a room has nine
 * people and may be able to name three of them. That is stated on the room rather than smoothed
 * over — see `lib/live/store.ts` — because a moderation surface implying a partial list is a whole
 * one would have somebody concluding a participant had left when they had merely joined first.
 *
 * ## Names come from the ACTIVE-CALLS topic, when the reader may see it
 *
 * A conference event carries a `legId` and no caller identity — the room does not know who anybody
 * is, only which leg they are. The `channels` bucket does know (`profile.callerIdNumber`), and the
 * two agree because the engine publishes `conference.joined` with the channel's own id as the leg
 * id. So the number is joined in when the reader holds `cdr.read` and the leg is shown by its id
 * when they do not — the grant boundary is real (`cdr.read` is call history) and a panel that
 * pretended otherwise would just render an empty column.
 */
export function LiveConferencesPanel() {
	const live = useLiveConferences();
	const calls = useLiveActiveCalls();
	const rooms = usePbxList<ConferenceRow>(PBX_RESOURCES.conferences, { page: 1, limit: 100 });
	const canModerate = usePermission("conferences.moderate");
	const moderation = useConferenceModeration();

	const [pendingKick, setPendingKick] = useState<{
		readonly conferenceId: string;
		readonly roomLabel: string;
		readonly participant: LiveConferenceParticipant;
	} | null>(null);

	const configured = new Map(rooms.rows.map((row) => [row.id, row]));
	/** Leg id → the number the switch resolved for it. Empty without `cdr.read`, which is fine. */
	const numbers = new Map(
		calls.legs.map((leg) => [
			leg.channelId,
			leg.profile?.callerIdName ?? leg.profile?.callerIdNumber ?? null,
		]),
	);

	if (!live.permitted) {
		return (
			<EmptyState
				title="You may not watch live conferences"
				description="This view needs conferences.read. An administrator can grant it under Settings → Members."
			/>
		);
	}

	if (!live.loaded) {
		return <LoadingPanel label="Waiting for the first frame" />;
	}

	if (live.rooms.length === 0) {
		return (
			<EmptyState
				title="No meeting is running"
				description="A room appears here the moment somebody dials into it, and disappears when the last person leaves. Nothing is recorded on the room itself — a mute lasts as long as the meeting does."
			/>
		);
	}

	return (
		<>
			<p className="text-sm text-muted-foreground">
				{live.rooms.length === 1 ? "One room is" : `${String(live.rooms.length)} rooms are`}{" "}
				running, with {String(live.memberCount)} {live.memberCount === 1 ? "person" : "people"} in{" "}
				{live.rooms.length === 1 ? "it" : "them"}. Counts are cluster-wide and come from the rooms
				themselves; the participant lists are assembled from what has happened since this page
				connected.
			</p>

			{live.rooms.map((room) => (
				<RoomCard
					key={room.conferenceId}
					room={room}
					configured={configured.get(room.conferenceId)}
					numbers={numbers}
					defaultExpanded={live.rooms.length <= COLLAPSE_ABOVE}
					canModerate={canModerate}
					pendingKey={moderation.pendingKey}
					onAction={(action, memberRef) => {
						moderation.run({
							conferenceId: room.conferenceId,
							roomLabel: roomLabelFor(room, configured.get(room.conferenceId)),
							action,
							...(memberRef === undefined ? {} : { memberRef }),
						});
					}}
					onKick={(participant) => {
						setPendingKick({
							conferenceId: room.conferenceId,
							roomLabel: roomLabelFor(room, configured.get(room.conferenceId)),
							participant,
						});
					}}
				/>
			))}

			{/*
			 * A kick is the one action here that cannot be undone by pressing the button again: the
			 * participant is out of the bridge and their leg is ended, and inviting them back means
			 * telephoning them. Mute has a symmetric Unmute one click away and does not get a dialog.
			 */}
			<ConfirmDialog
				open={pendingKick !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingKick(null);
					}
				}}
				title="Remove this participant?"
				description={
					pendingKick
						? `They are taken out of ${pendingKick.roomLabel} and their call is ended. They can dial back in unless the room is locked.`
						: ""
				}
				confirmLabel="Remove"
				destructive
				pending={moderation.isPending}
				onConfirm={() => {
					if (pendingKick === null) {
						return;
					}
					moderation.run({
						conferenceId: pendingKick.conferenceId,
						roomLabel: pendingKick.roomLabel,
						action: "kick",
						memberRef: pendingKick.participant.legId,
					});
					setPendingKick(null);
				}}
			/>
		</>
	);
}

function roomLabelFor(room: LiveConferenceRoomView, configured: ConferenceRow | undefined): string {
	if (configured !== undefined) {
		return `${configured.roomNumber} · ${configured.name}`;
	}
	const numbered = room.participants.find((participant) => participant.roomNumber.length > 0);
	return numbered?.roomNumber ?? "this room";
}

/**
 * Rooms start expanded at or below this many, collapsed above it.
 *
 * A moderator opening this page with one meeting running wants to see it; one with a dozen wants the
 * list first. The threshold is on the ROOM COUNT rather than on the member count, because it is the
 * number of cards competing for the screen that makes the difference.
 */
const COLLAPSE_ABOVE = 4;

function RoomCard({
	room,
	configured,
	numbers,
	defaultExpanded,
	canModerate,
	pendingKey,
	onAction,
	onKick,
}: {
	room: LiveConferenceRoomView;
	configured: ConferenceRow | undefined;
	numbers: ReadonlyMap<string, string | null>;
	defaultExpanded: boolean;
	canModerate: boolean;
	pendingKey: string | null;
	onAction: (
		action: "mute" | "unmute" | "deaf" | "undeaf" | "lock" | "unlock",
		memberRef?: string,
	) => void;
	onKick: (participant: LiveConferenceParticipant) => void;
}) {
	const [expanded, setExpanded] = useState(defaultExpanded);
	const roomBusy = pendingKey === conferenceTargetKey(room.conferenceId);
	const label = roomLabelFor(room, configured);

	return (
		<Card>
			<CardHeader className="flex flex-wrap items-center gap-x-3 gap-y-2">
				<CardTitle className="min-w-0 flex-1 truncate">{label}</CardTitle>

				<Badge tone="neutral" data-tabular>
					{room.memberCount} {room.memberCount === 1 ? "person" : "people"}
					{configured && configured.maxMembers > 0 ? ` of ${String(configured.maxMembers)}` : null}
				</Badge>
				{room.locked ? <Badge tone="warning">Locked</Badge> : null}
				{room.moderatorPresent ? (
					<Badge tone="success">Moderator</Badge>
				) : configured?.waitForModerator ? (
					<Badge tone="warning" title="Everybody is holding until a moderator arrives">
						Waiting for a moderator
					</Badge>
				) : null}

				<Button
					size="sm"
					variant={room.locked ? "secondary" : "ghost"}
					disabled={!canModerate}
					loading={roomBusy}
					onClick={() => onAction(room.locked ? "unlock" : "lock")}
					title={
						canModerate
							? undefined
							: "Locking a room needs the conferences.moderate permission, which your role does not include."
					}
				>
					{room.locked ? "Unlock" : "Lock"}
				</Button>

				<Button size="sm" variant="ghost" onClick={() => setExpanded((open) => !open)}>
					{expanded ? "Hide people" : "Show people"}
				</Button>
			</CardHeader>

			{expanded ? (
				<CardBody className="flex flex-col gap-3">
					{room.incomplete ? (
						<p className="text-xs text-subtle-foreground">
							{room.participants.length === 0
								? "Nobody is listed yet. The room reports its size the moment this page connects; the people in it are learned as they join, leave or are moderated — so a meeting already under way fills in as it moves."
								: `Listing ${String(room.participants.length)} of ${String(room.memberCount)}. The rest joined before this page connected and appear as soon as anything about them changes.`}
						</p>
					) : null}

					{room.participants.length > 0 ? (
						<ul className="flex flex-col gap-2">
							{room.participants.map((participant) => (
								<ParticipantRow
									key={participant.legId}
									participant={participant}
									name={numbers.get(participant.legId) ?? null}
									canModerate={canModerate}
									busy={pendingKey === conferenceTargetKey(room.conferenceId, participant.legId)}
									onAction={onAction}
									onKick={onKick}
								/>
							))}
						</ul>
					) : null}

					{!canModerate ? (
						<p className="text-xs text-subtle-foreground">
							Muting, deafening, removing somebody and locking the room need the
							conferences.moderate grant, which your role does not include. Everything above is what
							the meeting looks like from here.
						</p>
					) : null}
				</CardBody>
			) : null}
		</Card>
	);
}

function ParticipantRow({
	participant,
	name,
	canModerate,
	busy,
	onAction,
	onKick,
}: {
	participant: LiveConferenceParticipant;
	name: string | null;
	canModerate: boolean;
	busy: boolean;
	onAction: (action: "mute" | "unmute" | "deaf" | "undeaf", memberRef: string) => void;
	onKick: (participant: LiveConferenceParticipant) => void;
}) {
	/**
	 * The clock is the LIVE HOOK's, not a second one of this row's own.
	 *
	 * `useLiveConferences` already ticks once a second while any room is running, and it does so
	 * because a contribution's lease has to be re-checked anyway. That tick re-renders this row, so
	 * reading the wall clock here is enough — a `setInterval` per participant would be one timer per
	 * person in the building to display the same second the parent already computed.
	 */
	const now = Date.now();

	return (
		<li className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-panel border border-border bg-canvas px-3 py-2">
			<span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
				{name ?? (
					<span className="font-mono text-xs text-muted-foreground">
						{participant.legId.slice(0, 8)}…
					</span>
				)}
			</span>

			<span className="text-xs text-muted-foreground" data-tabular>
				{participant.joinedAt === undefined ? (
					<span title="They were already in the room when this page connected, and the room does not record when anybody arrived.">
						—
					</span>
				) : (
					formatDuration(Math.max(0, now - participant.joinedAt))
				)}
			</span>

			{participant.moderator ? <Badge tone="success">Moderator</Badge> : null}
			{participant.muted ? <Badge tone="warning">Muted</Badge> : null}
			{participant.deafened ? <Badge tone="warning">Deafened</Badge> : null}
			{participant.talkGainPercent !== CONFERENCE_UNITY_GAIN_PERCENT ||
			participant.listenGainPercent !== CONFERENCE_UNITY_GAIN_PERCENT ? (
				<Badge tone="accent" data-tabular>
					{participant.talkGainPercent}% / {participant.listenGainPercent}%
				</Badge>
			) : null}

			<div className="flex flex-wrap items-center gap-1.5">
				<Button
					size="sm"
					variant="ghost"
					disabled={!canModerate}
					loading={busy}
					onClick={() => onAction(participant.muted ? "unmute" : "mute", participant.legId)}
					aria-label={`${participant.muted ? "Unmute" : "Mute"} ${name ?? participant.legId}`}
					title={canModerate ? undefined : MODERATE_HINT}
				>
					{participant.muted ? "Unmute" : "Mute"}
				</Button>

				<Button
					size="sm"
					variant="ghost"
					disabled={!canModerate}
					loading={busy}
					onClick={() => onAction(participant.deafened ? "undeaf" : "deaf", participant.legId)}
					aria-label={`${participant.deafened ? "Undeafen" : "Deafen"} ${name ?? participant.legId}`}
					title={
						canModerate
							? "Deafening takes the room away from them; muting takes them away from the room."
							: MODERATE_HINT
					}
				>
					{participant.deafened ? "Undeafen" : "Deafen"}
				</Button>

				{/*
				 * Rendered DISABLED rather than omitted, and the copy names the refusal.
				 *
				 * `POST …/participants/:ref/volume` exists and answers a typed 501,
				 * `CONFERENCE_ACTION_NOT_SERVABLE`, on both drivers this platform runs. What is missing
				 * is a WIRE and not a feature: Asterisk has no per-participant gain on a mixing bridge
				 * at all, and `apps/mediad`'s mixer has `Member.SetGain` with no subject that reaches
				 * it. Hiding the control would tell an operator this product has no volume control and
				 * send them to a competitor's feature list; a control that says what is missing tells
				 * them the truth and is one release from working.
				 */}
				<Button
					size="sm"
					variant="ghost"
					disabled
					aria-label={`Set level for ${name ?? participant.legId}`}
					title="Per-participant level is not servable on this platform: no media plane exposes a per-member gain command yet, so the API answers this control with a 501. The mixer applies unity to everybody."
				>
					Level…
				</Button>

				<Button
					size="sm"
					variant="ghost"
					disabled={!canModerate}
					loading={busy}
					onClick={() => onKick(participant)}
					aria-label={`Remove ${name ?? participant.legId} from the meeting`}
					title={canModerate ? undefined : MODERATE_HINT}
				>
					Remove
				</Button>
			</div>
		</li>
	);
}

const MODERATE_HINT =
	"This needs the conferences.moderate permission, which your role does not include.";
