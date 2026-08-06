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
import { useVoicemailPin } from "../../_hooks/use-voicemail-queries";
import type { VoicemailBoxRow } from "~/lib/pbx/contracts";

/**
 * Set or clear a mailbox PIN.
 *
 * ## Why this is not a field on the mailbox form
 *
 * A PIN is a secret with a lifecycle, not a setting. It is hashed on arrival (`scrypt`, in the
 * digest format `packages/routing` owns), never read back, and never returned — the server strips
 * `pinHash` from every response, so there is no "current value" this form could prefill and no way
 * for it to show whether one is set. Putting it in the mailbox `PATCH` would mean a request body
 * that sometimes carries a plaintext PIN, which is a request body that ends up in a debug log.
 *
 * The consequence is visible and deliberate: this dialog cannot say "a PIN is currently set". It
 * says what the two buttons DO instead, which is the honest version.
 *
 * ## The policy lives on the server
 *
 * Digits, 4–10, and not one of the shapes an attacker tries first. This form does the cheap check
 * (digits, length) so the common mistake is caught without a round trip, and renders whatever the
 * server says for everything else — because the server is the authority and a second copy of the
 * blocklist here would be a second thing to keep in step.
 */

const MIN_PIN_LENGTH = 4;
const MAX_PIN_LENGTH = 10;

export function VoicemailPinDialog({
	open,
	onOpenChange,
	box,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	box: VoicemailBoxRow | null;
}) {
	const inputId = useId();
	const [pin, setPin] = useState("");
	const [localError, setLocalError] = useState<string | null>(null);
	const mutation = useVoicemailPin();

	const close = (): void => {
		setPin("");
		setLocalError(null);
		mutation.reset();
		onOpenChange(false);
	};

	const submit = (): void => {
		if (box === null) {
			return;
		}
		if (!/^\d+$/u.test(pin)) {
			setLocalError("A PIN is digits only — it is entered on a telephone keypad.");
			return;
		}
		if (pin.length < MIN_PIN_LENGTH || pin.length > MAX_PIN_LENGTH) {
			setLocalError(`A PIN is between ${MIN_PIN_LENGTH} and ${MAX_PIN_LENGTH} digits.`);
			return;
		}
		setLocalError(null);
		mutation.mutate({ boxId: box.id, pin }, { onSuccess: close });
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
						{box === null ? "Mailbox PIN" : `PIN for mailbox ${box.mailboxNumber}`}
					</DialogTitle>
					<DialogDescription>
						Callers dialling <code>*97</code> from another handset are asked for this. Without
						one, the mailbox opens for anyone calling from its own extension.
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
						New PIN
					</label>
					<input
						id={inputId}
						/*
						 * `type="password"` with a numeric mode: it is a secret, so it should not be
						 * shoulder-readable, and it is digits, so a phone should offer a keypad rather
						 * than a full keyboard. `autoComplete="off"` because a browser offering to
						 * remember an administrator's colleague's mailbox PIN is not a feature.
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
						{MIN_PIN_LENGTH}–{MAX_PIN_LENGTH} digits. A repeated digit ({"0000"}) or a straight
						run ({"1234"}) is refused: the handset allows three attempts per call, and those are
						the first three anyone tries.
					</p>
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
							disabled={mutation.isPending || box === null}
							onClick={() => {
								if (box !== null) {
									mutation.mutate({ boxId: box.id, pin: null }, { onSuccess: close });
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
