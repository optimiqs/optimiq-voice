"use client";

import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/field";
import { PhoneIcon } from "~/components/ui/icons";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/cn";
import { canPlaceCall } from "~/lib/softphone/call-state";
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
			</p>
		);
	}

	const registered = state.registration === "registered";
	const call = state.call;

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
								{call.onHold ? "On hold" : "Connected"} · {duration}
							</p>
						</div>
					</div>
					<MediaBoundaryNote note={phone.mediaNote} />
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
				</form>
			) : null}
		</div>
	);
}
