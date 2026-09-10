"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/field";
import { PhoneIcon } from "~/components/ui/icons";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/cn";
import { canPlaceCall } from "~/lib/softphone/call-state";
import {
	isRecordingControlVisible,
	recordingControlLabel,
	recordingStatusLabel,
} from "~/lib/softphone/recording";
import { isTransferring } from "~/lib/softphone/transfer";
import { useSoftphone } from "../../_context/softphone-context";

/**
 * The dialer and in-call controls — the whole softphone minus its chrome.
 *
 * Shared by the docked widget and the `/softphone` route so the two cannot drift. It is a strict
 * function of `useSoftphone()`: the registration state decides whether it shows a Connect button, a
 * keypad, a ringing card or an in-call panel, and nothing here reaches for the SIP stack directly.
 */

const KEYPAD: readonly (readonly [string, string])[] = [
	["1", ""],
	["2", "ABC"],
	["3", "DEF"],
	["4", "GHI"],
	["5", "JKL"],
	["6", "MNO"],
	["7", "PQRS"],
	["8", "TUV"],
	["9", "WXYZ"],
	["*", ""],
	["0", "+"],
	["#", ""],
];

function REGISTRATION_LABEL(state: string): string {
	switch (state) {
		case "registered":
			return "Online";
		case "registering":
			return "Connecting…";
		case "registration-failed":
			return "Connection failed";
		default:
			return "Offline";
	}
}

function useCallDuration(connectedAt: number | null): string {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (connectedAt === null) {
			return;
		}
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [connectedAt]);
	if (connectedAt === null) {
		return "0:00";
	}
	const total = Math.max(0, Math.floor((now - connectedAt) / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** The media plane is not built yet — say so wherever a call is live rather than imply audio. */
function MediaBoundaryNote({ note }: { note: string }) {
	return (
		<p className="rounded-field bg-warning-subtle px-3 py-2 text-xs text-foreground">
			<span className="font-medium">No audio yet.</span> {note}
		</p>
	);
}

export function SoftphoneDialer() {
	const phone = useSoftphone();
	const { state } = phone;
	const [target, setTarget] = useState("");
	const duration = useCallDuration(state.call.connectedAt);

	if (phone.isLoading) {
		return (
			<div className="flex items-center justify-center py-8">
				<Spinner label="Loading your softphone" />
			</div>
		);
	}

	if (!phone.extension) {
		return (
			<p className="px-1 py-6 text-center text-sm text-muted-foreground">
				{phone.unavailableReason ?? "No softphone is available for your account."}
				<UnavailableLink href={phone.unavailableHref} />
			</p>
		);
	}

	const registered = state.registration === "registered";
	const call = state.call;
	const parkCode = phone.featureCodes["call-park"];
	const dndCode = phone.featureCodes["do-not-disturb"];

	return (
		<div className="flex flex-col gap-4">
			{/* Identity + registration status */}
			<div className="flex items-center justify-between gap-2">
				<div className="min-w-0">
					<p className="truncate text-sm font-medium text-foreground">
						{phone.extension.displayName}
					</p>
					<p className="truncate text-xs text-muted-foreground">
						Extension {phone.extension.number}
					</p>
				</div>
				<span
					className={cn(
						"inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium",
						registered
							? "bg-success-subtle text-foreground"
							: state.registration === "registration-failed"
								? "bg-danger-subtle text-foreground"
								: "bg-muted text-muted-foreground",
					)}
				>
					<span
						aria-hidden="true"
						className={cn(
							"size-1.5 rounded-full",
							registered
								? "bg-success"
								: state.registration === "registration-failed"
									? "bg-danger"
									: "bg-subtle-foreground",
						)}
					/>
					{REGISTRATION_LABEL(state.registration)}
				</span>
			</div>

			{state.error ? (
				<p className="rounded-field bg-danger-subtle px-3 py-2 text-xs text-foreground">
					{state.error}
				</p>
			) : null}

			{/* Not connected yet — the explicit online toggle */}
			{!phone.available ? (
				<p className="rounded-field bg-muted px-3 py-2 text-xs text-muted-foreground">
					{phone.unavailableReason}
					<UnavailableLink href={phone.unavailableHref} />
				</p>
			) : call.status === "idle" && !registered ? (
				<div className="flex flex-col gap-2">
					{!phone.webrtcSupported ? <MediaBoundaryNote note={phone.mediaNote} /> : null}
					<Button
						variant="primary"
						onClick={phone.connect}
						loading={state.registration === "registering"}
					>
						Go online
					</Button>
				</div>
			) : null}

			{/* Incoming call */}
			{call.status === "ringing" && call.direction === "incoming" ? (
				<div className="flex flex-col gap-3 rounded-panel border border-border bg-surface-raised p-3">
					<div>
						<p className="text-xs uppercase tracking-wide text-muted-foreground">Incoming call</p>
						<p className="text-sm font-medium text-foreground">
							{call.peer?.displayName ?? call.peer?.identity ?? "Unknown"}
						</p>
						{call.peer?.displayName ? (
							<p className="text-xs text-muted-foreground">{call.peer.identity}</p>
						) : null}
					</div>
					<div className="flex gap-2">
						<Button variant="primary" className="flex-1" onClick={phone.answer}>
							Answer
						</Button>
						<Button variant="danger" className="flex-1" onClick={phone.hangup}>
							Reject
						</Button>
					</div>
				</div>
			) : null}

			{/* Outgoing, ringing */}
			{call.status === "ringing" && call.direction === "outgoing" ? (
				<div className="flex flex-col gap-3 rounded-panel border border-border bg-surface-raised p-3">
					<div>
						<p className="text-xs uppercase tracking-wide text-muted-foreground">Calling…</p>
						<p className="text-sm font-medium text-foreground">{call.peer?.identity ?? target}</p>
					</div>
					<Button variant="danger" onClick={phone.hangup}>
						Cancel
					</Button>
				</div>
			) : null}

			{/* Active call */}
			{call.status === "active" ? (
				<div className="flex flex-col gap-3 rounded-panel border border-border bg-surface-raised p-3">
					<div className="flex items-center justify-between">
						<div>
							<p className="text-sm font-medium text-foreground">
								{call.peer?.displayName ?? call.peer?.identity ?? "In call"}
							</p>
							<p className="text-xs text-muted-foreground" data-tabular>
								{call.onHold
									? "On hold"
									: call.remoteHold
										? "The other party put you on hold"
										: "Connected"}{" "}
								· {duration}
							</p>
						</div>
					</div>
					{!phone.webrtcSupported ? <MediaBoundaryNote note={phone.mediaNote} /> : null}
					<div className="flex gap-2">
						<Button
							variant={call.muted ? "primary" : "secondary"}
							size="sm"
							className="flex-1"
							onClick={phone.toggleMute}
							aria-pressed={call.muted}
						>
							{call.muted ? "Unmute" : "Mute"}
						</Button>
						<Button
							variant={call.onHold ? "primary" : "secondary"}
							size="sm"
							className="flex-1"
							onClick={phone.toggleHold}
							aria-pressed={call.onHold}
						>
							{call.onHold ? "Resume" : "Hold"}
						</Button>
						<Button variant="danger" size="sm" className="flex-1" onClick={phone.hangup}>
							Hang up
						</Button>
					</div>
					<RecordingControls />
					<TransferControls />

					{/*
					 * Park is a BLIND TRANSFER to the organization's park code, not a DTMF burst: the call has
					 * to leave this endpoint for the lot, which is a REFER. No configured code, no button —
					 * there is no platform default for one.
					 */}
					{parkCode && !isTransferring(state.transfer) ? (
						<Button
							variant="secondary"
							size="sm"
							onClick={() => phone.transferBlind(parkCode)}
							disabled={!call.connectedAt}
						>
							Park on {parkCode}
						</Button>
					) : null}

					{/* In-call DTMF keypad */}
					<div className="grid grid-cols-3 gap-1.5">
						{KEYPAD.map(([digit]) => (
							<button
								key={digit}
								type="button"
								onClick={() => phone.sendDtmf(digit)}
								className="rounded-field border border-border bg-surface py-2 text-sm font-medium text-foreground transition-colors hover:bg-hover"
							>
								{digit}
							</button>
						))}
					</div>
					{call.dtmfSent ? (
						<p className="text-center text-xs text-muted-foreground" data-tabular>
							Sent: {call.dtmfSent}
						</p>
					) : null}
				</div>
			) : null}

			{/* Ended */}
			{call.status === "ended" ? (
				<div className="flex flex-col gap-3 rounded-panel border border-border bg-surface-raised p-3">
					<div>
						<p className="text-sm font-medium text-foreground">Call ended</p>
						<p className="text-xs text-muted-foreground">{call.endedReason}</p>
					</div>
					<Button variant="secondary" onClick={phone.dismissEndedCall}>
						Done
					</Button>
				</div>
			) : null}

			{/* Idle dialer, only when registered */}
			{registered && call.status === "idle" ? (
				<form
					className="flex flex-col gap-3"
					onSubmit={(event) => {
						event.preventDefault();
						if (canPlaceCall(state)) {
							phone.dial(target);
						}
					}}
				>
					<Input
						value={target}
						onChange={(event) => setTarget(event.target.value)}
						placeholder="Extension or number"
						inputMode="tel"
						aria-label="Number to dial"
						className="text-center text-lg tracking-wide"
						data-tabular
					/>
					<div className="grid grid-cols-3 gap-1.5">
						{KEYPAD.map(([digit, letters]) => (
							<button
								key={digit}
								type="button"
								onClick={() => setTarget((value) => value + digit)}
								className="flex flex-col items-center rounded-field border border-border bg-surface py-2 transition-colors hover:bg-hover"
							>
								<span className="text-base font-medium text-foreground">{digit}</span>
								{letters ? (
									<span className="text-[0.625rem] tracking-widest text-subtle-foreground">
										{letters}
									</span>
								) : null}
							</button>
						))}
					</div>
					<div className="flex gap-2">
						{target ? (
							<Button
								type="button"
								variant="ghost"
								size="icon"
								aria-label="Backspace"
								onClick={() => setTarget((value) => value.slice(0, -1))}
							>
								⌫
							</Button>
						) : null}
						<Button
							type="submit"
							variant="primary"
							className="flex-1"
							disabled={!canPlaceCall(state) || target.trim().length === 0}
						>
							<PhoneIcon aria-hidden="true" />
							Call
						</Button>
					</div>
					{phone.lastDialed ? (
						<Button
							type="button"
							variant="secondary"
							size="sm"
							onClick={() => phone.dial(phone.lastDialed ?? "")}
							disabled={!canPlaceCall(state)}
						>
							Redial {phone.lastDialed}
						</Button>
					) : null}
				</form>
			) : null}

			{/*
			 * Recents, and the two things a user can do to their own registration.
			 *
			 * Only while idle and online: dialling DND mid-call would put the digits into the call, and
			 * going offline mid-call would drop it.
			 */}
			{registered && call.status === "idle" ? (
				<div className="flex flex-col gap-3 border-t border-border pt-3">
					{phone.recents.length > 0 ? (
						<div className="flex flex-col gap-1">
							<p className="text-xs uppercase tracking-wide text-muted-foreground">Recent</p>
							<ul className="flex flex-col">
								{phone.recents.map((entry) => (
									<li key={entry.id}>
										<button
											type="button"
											onClick={() => setTarget(entry.number)}
											className="flex w-full items-baseline justify-between gap-2 rounded-field px-2 py-1.5 text-left transition-colors hover:bg-hover"
										>
											<span className="min-w-0 truncate text-sm text-foreground" data-tabular>
												{entry.name ?? entry.number}
											</span>
											<span className="shrink-0 text-xs text-muted-foreground">
												{entry.direction === "out"
													? "Outgoing"
													: entry.answered
														? "Incoming"
														: "Missed"}
											</span>
										</button>
									</li>
								))}
							</ul>
						</div>
					) : null}
					<div className="flex gap-2">
						{dndCode ? (
							<Button
								variant="secondary"
								size="sm"
								className="flex-1"
								onClick={() => phone.dial(dndCode)}
							>
								Do not disturb ({dndCode})
							</Button>
						) : null}
						<Button variant="ghost" size="sm" className="flex-1" onClick={phone.disconnect}>
							Go offline
						</Button>
					</div>
					{dndCode ? (
						<p className="text-xs text-muted-foreground">
							Dialling {dndCode} toggles do-not-disturb on your extension. The platform answers with
							the new state; this phone does not track it.
						</p>
					) : null}
				</div>
			) : null}
		</div>
	);
}

/**
 * Blind and attended transfer.
 *
 * Two operations behind one control, because to the user they are one intention with two ways of
 * meeting it: "send this call to 2003" (blind — REFER and let go) and "ask 2003 first" (attended —
 * hold, consult, then REFER with `Replaces`). `apps/sipd` implements the receiving half of both.
 *
 * The states are honest about what SIP can tell us. A blind transfer's REFER is acknowledged, not
 * completed — nothing on the wire says the transferee ever answered — so `referring` says
 * "transferring", never "transferred", and the call simply ends. A failure keeps the call: the
 * first party comes back off hold and the panel says which step refused.
 */
/**
 * The PCI pause — shown only while the platform says this call is being recorded.
 *
 * Hidden rather than disabled when there is no recording, on the `Park on …` precedent above: a
 * control for something this call is not doing is noise on a panel an agent uses all day. Its
 * enabling and its label come from `lib/softphone/recording.ts`, which is where the guard that
 * matters lives — the button must not claim "Paused" before the engine has said so.
 */
function RecordingControls() {
	const phone = useSoftphone();
	const recording = phone.recording;
	if (!isRecordingControlVisible(recording)) {
		return null;
	}
	const paused = recording.status === "paused";
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center gap-2">
				<span
					aria-hidden
					className={cn(
						"size-2 rounded-full",
						paused ? "bg-muted-foreground" : "bg-danger animate-pulse",
					)}
				/>
				<p className="text-xs text-muted-foreground">{recordingStatusLabel(recording)}</p>
				<Button
					variant={paused ? "primary" : "secondary"}
					size="sm"
					className="ml-auto"
					onClick={paused ? phone.resumeRecording : phone.pauseRecording}
					disabled={recording.pending}
					aria-pressed={paused}
				>
					{recordingControlLabel(recording)}
				</Button>
			</div>
			{recording.error ? (
				<p className="rounded-field bg-warning-subtle px-3 py-2 text-xs text-foreground">
					<span className="font-medium">{paused ? "Still paused." : "Still recording."}</span>{" "}
					{recording.error}
				</p>
			) : null}
		</div>
	);
}

function TransferControls() {
	const phone = useSoftphone();
	const { transfer } = phone.state;
	const [target, setTarget] = useState("");
	const [open, setOpen] = useState(false);

	// A finished transfer leaves the form behind it; reopening should not pre-fill the last target.
	useEffect(() => {
		if (transfer.status === "idle") {
			setOpen(false);
			setTarget("");
		}
	}, [transfer.status]);

	if (transfer.status === "consult-ringing" || transfer.status === "consult-active") {
		const answered = transfer.status === "consult-active";
		return (
			<div className="flex flex-col gap-2 rounded-field bg-muted px-3 py-2">
				<p className="text-xs text-foreground">
					{answered ? "Talking to" : "Calling"} {transfer.target} · the first call is on hold
				</p>
				<div className="flex gap-2">
					<Button
						variant="primary"
						size="sm"
						className="flex-1"
						onClick={phone.completeTransfer}
						disabled={!answered}
					>
						Complete transfer
					</Button>
					<Button variant="secondary" size="sm" className="flex-1" onClick={phone.cancelTransfer}>
						Cancel
					</Button>
				</div>
			</div>
		);
	}

	if (transfer.status === "referring" || transfer.status === "completing") {
		return (
			<p className="rounded-field bg-muted px-3 py-2 text-xs text-muted-foreground">
				Transferring to {transfer.target}…
			</p>
		);
	}

	return (
		<div className="flex flex-col gap-2">
			{transfer.status === "failed" ? (
				<p className="rounded-field bg-danger-subtle px-3 py-2 text-xs text-foreground">
					{transfer.error}
				</p>
			) : null}
			{open ? (
				<form
					className="flex flex-col gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						phone.startConsult(target);
					}}
				>
					<Input
						value={target}
						onChange={(event) => setTarget(event.target.value)}
						placeholder="Transfer to"
						inputMode="tel"
						aria-label="Transfer to"
						data-tabular
					/>
					<div className="flex gap-2">
						<Button
							type="submit"
							variant="primary"
							size="sm"
							className="flex-1"
							disabled={target.trim().length === 0}
						>
							Ask first
						</Button>
						<Button
							type="button"
							variant="secondary"
							size="sm"
							className="flex-1"
							onClick={() => phone.transferBlind(target)}
							disabled={target.trim().length === 0}
						>
							Transfer now
						</Button>
					</div>
					<Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
						Cancel
					</Button>
				</form>
			) : (
				<Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
					Transfer
				</Button>
			)}
		</div>
	);
}

/** The way out of a fixable unavailability — today, the organization's calling domain. */
function UnavailableLink({ href }: { href: string | null }) {
	if (href === null) {
		return null;
	}
	return (
		<>
			{" "}
			<Link href={href} className="underline underline-offset-2">
				Open settings
			</Link>
		</>
	);
}
