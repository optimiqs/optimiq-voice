"use client";

import { useId, useState } from "react";
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
import { pbxFormMessage } from "~/lib/pbx/errors";
import { keypadPinIssue, MAX_PIN_LENGTH, MIN_PIN_LENGTH } from "~/lib/pbx/schemas";
import { useConferencePin } from "../../_hooks/use-media-queries";
import type { ConferencePinRole } from "~/lib/pbx/client";
import type { ConferenceRow } from "~/lib/pbx/contracts";

/**
 * Set or clear one of a room's two PINs.
 *
 * ## Why this is not a field on the conference form
 *
 * The same reason the mailbox PIN is not a field on the mailbox form: a PIN is a secret with a
 * lifecycle, not a setting. It is hashed on arrival with scrypt, never read back, and never
 * returned — `secretColumns` strips `pinHash` and `moderatorPinHash` from every response — so there
 * is no current value this form could prefill and no way for it to render "a PIN is set". Putting
 * it in the conference `PATCH` would mean a request body that sometimes carries a plaintext PIN,
 * which is a request body that ends up in a debug log.
 *
 * ## Why one component serves both PINs
 *
 * Two endpoints, one shape. The server hashes both with the same function and the same policy, the
 * form does the same cheap keypad check for both, and the only thing that varies is which noun the
 * copy uses and what the PIN actually DOES. A second component would be a second place to keep the
 * digit-stripping, the "clear" affordance and the length rule in step.
 *
 * ## What each PIN does, and the difference is not cosmetic
 *
 * Both are enforced. `pinSet` and `moderatorPinSet` reach the compiled artifact as
 * `ConferencePlanNode.requiresPin` / `requiresModeratorPin`, with the digests alongside them, so
 * setting either changes what a caller is asked for on the next call after the recompile.
 *
 * There is **one** prompt for both. The engine checks the digits against the moderator digest
 * first and the participant digest second, so a moderator dials the room like anyone else and is
 * recognised rather than having to announce themselves; the caller is never told which of the two
 * they matched. A room whose only credential is the moderator's admits an empty entry as a
 * participant, which is what makes a moderator PIN usable on its own.
 *
 * The difference is what admission means. Matching the **moderator** digest also satisfies
 * `waitForModerator` for everybody already holding — that is the whole point of the flag, and it
 * is why the moderator variant carries a note when the room has it switched on: until a moderator
 * PIN exists, nobody can arrive as one and every participant sits in music-on-hold until the
 * engine's wait budget expires.
 *
 * ## The policy lives on the server
 *
 * `keypadPinIssue` is the client's copy of the cheap half: digits, 4–10, and not one of the two
 * shapes an attacker tries first. It runs here so the common mistake is caught without a round
 * trip. Everything else is whatever the server says, rendered under the input — because the server
 * is the authority and a second copy of its rules here would be a second thing to keep in step.
 */
export function ConferencePinDialog({
	open,
	onOpenChange,
	conference,
	role,
}: {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly conference: ConferenceRow | null;
	readonly role: ConferencePinRole;
}) {
	const inputId = useId();
	const [pin, setPin] = useState("");
	const [localError, setLocalError] = useState<string | null>(null);
	const mutation = useConferencePin();

	const isModerator = role === "moderator";
	const noun = isModerator ? "Moderator PIN" : "Room PIN";

	const close = (): void => {
		setPin("");
		setLocalError(null);
		mutation.reset();
		onOpenChange(false);
	};

	const submit = (): void => {
		if (conference === null) {
			return;
		}
		const issue = keypadPinIssue(pin);
		if (issue !== undefined) {
			setLocalError(issue);
			return;
		}
		setLocalError(null);
		mutation.mutate({ conferenceId: conference.id, role, pin }, { onSuccess: close });
	};

	const serverError =
		mutation.error === null || mutation.error === undefined
			? undefined
			: pbxFormMessage(mutation.error);

	return (
		<Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{conference === null ? noun : `${noun} for room ${conference.roomNumber}`}
					</DialogTitle>
					<DialogDescription>
						{isModerator
							? "Asked for at the same prompt as the room PIN. Entering it admits the caller as a moderator, which also releases anyone held waiting for one."
							: "Asked for when somebody dials this room. Without one, anyone who can reach the number is admitted."}
					</DialogDescription>
				</DialogHeader>

				<form
					noValidate
					onSubmit={(event) => {
						event.preventDefault();
						submit();
					}}
				>
					<label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">
						New {noun.toLowerCase()}
					</label>
					<input
						id={inputId}
						/*
						 * `type="password"` with a numeric mode, exactly as the mailbox PIN input: it is a
						 * secret, so it should not be shoulder-readable, and it is digits, so a phone
						 * should offer a keypad rather than a full keyboard. `autoComplete="off"` because
						 * a browser offering to remember a colleague's conference PIN is not a feature.
						 */
						type="password"
						inputMode="numeric"
						autoComplete="off"
						autoFocus
						value={pin}
						maxLength={MAX_PIN_LENGTH}
						onChange={(event) => {
							setPin(event.target.value.replace(/\D/gu, ""));
							setLocalError(null);
						}}
						placeholder="••••"
						className={`${inputClassName} mt-1.5 w-full`}
						aria-describedby={`${inputId}-help`}
					/>
					<p id={`${inputId}-help`} className="mt-1.5 text-xs text-muted-foreground">
						{MIN_PIN_LENGTH}–{MAX_PIN_LENGTH} digits. A repeated digit ({"0000"}) or a straight run
						({"1234"}) is refused: the handset allows three attempts per call, and those are the
						first three anyone tries.
					</p>

					{isModerator && conference?.waitForModerator === true ? (
						<p className="mt-2 rounded-panel border border-warning/40 bg-warning-subtle px-3 py-2 text-xs text-foreground">
							This room holds participants until a moderator arrives, and entering this PIN is how
							somebody arrives as one. Until a moderator PIN is set, everybody who dials in waits in
							music-on-hold until the wait budget runs out and the call ends.
						</p>
					) : null}

					{localError !== null ? (
						<p className="mt-2 text-xs text-danger">{localError}</p>
					) : serverError !== undefined ? (
						<p className="mt-2 text-xs text-danger">{serverError}</p>
					) : null}

					<DialogFooter className="items-center justify-between sm:justify-between">
						<Button
							type="button"
							size="sm"
							variant="ghost"
							className="text-danger"
							disabled={mutation.isPending || conference === null}
							onClick={() => {
								if (conference !== null) {
									mutation.mutate(
										{ conferenceId: conference.id, role, pin: null },
										{ onSuccess: close },
									);
								}
							}}
						>
							Clear PIN
						</Button>
						<div className="flex items-center gap-2">
							<Button type="button" size="sm" variant="secondary" onClick={close}>
								Cancel
							</Button>
							<Button
								type="submit"
								size="sm"
								variant="primary"
								disabled={mutation.isPending || pin.length === 0}
							>
								{mutation.isPending ? "Saving…" : "Set PIN"}
							</Button>
						</div>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
