"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { EntityFormDialog } from "~/components/pbx/entity-form-dialog";
import { NoticeBanner } from "~/components/pbx/warnings-banner";
import { focusRing } from "~/components/ui/focus-ring";
import { cn } from "~/lib/cn";
import {
	DEFAULT_GRACE_MINUTES,
	MAX_GRACE_MINUTES,
	rotateExtensionSecret,
	setExtensionSecret,
	type RotationResult,
} from "~/lib/sip-credentials/client";
import {
	MIN_SIP_SECRET_LENGTH,
	weakSipSecretMessage,
	weakSipSecretReason,
} from "~/lib/sip-credentials/secret-strength";
import type { ExtensionRow } from "~/lib/pbx/contracts";

/**
 * Issue a new SIP secret for an extension, or set one by hand.
 *
 * ## What "rotate" actually does, and why there is no secret to copy down
 *
 * A rotation writes a new secret HANDLE. The password itself is derived from that handle and a root
 * key this app never sees, so `POST …/rotate` has nothing to return but the deadline — and this
 * dialog shows the deadline rather than inventing a "here is your new password, copy it now" moment
 * for a value that does not exist. The handset picks the credential up through provisioning.
 *
 * The grace period is the whole reason the operation is survivable, so it is stated in plain words
 * rather than as a number beside a label: until the deadline, BOTH secrets authenticate, which is
 * what gives a desk phone time to re-provision on its own schedule. After it, a phone still holding
 * the old one stops registering — it does not fail a call, it disappears — and the fix is to
 * re-provision it.
 *
 * Zero minutes is offered and is the incident case: a rotation performed BECAUSE a credential leaked
 * should not extend a courtesy window to whoever leaked it.
 *
 * ## Setting a secret by hand is the one path with a strength check
 *
 * Every other credential on this platform is derived and cannot be weak. `POST …/secret` is where a
 * person types one, so the rules in `lib/sip-credentials/secret-strength.ts` — a mirror of the
 * server's `sip-secret-strength.ts`, rule for rule — are applied before the request rather than
 * after it. The server runs the same check regardless; this only means the refusal arrives while
 * the person is still looking at the value they chose.
 *
 * There is no device-line rotation here. `POST /sip-credentials/device-lines/:lineId/rotate` exists
 * and `rotateDeviceLineSecret` calls it, but this app has no surface that renders a device LINE as
 * a row with an id — `lib/pbx/client.ts` has no `device-lines` resource — so there is nowhere to
 * hang the action. It belongs on the device screen when that screen lists lines.
 */

type Mode = "rotate" | "set";

const GRACE_CHOICES: readonly { readonly minutes: number; readonly label: string }[] = [
	{ minutes: 0, label: "Immediately" },
	{ minutes: DEFAULT_GRACE_MINUTES, label: "15 minutes" },
	{ minutes: 60, label: "1 hour" },
	{ minutes: 480, label: "8 hours" },
	{ minutes: MAX_GRACE_MINUTES, label: "24 hours" },
];

export function RotateSecretDialog({
	extension,
	onClose,
}: {
	extension: ExtensionRow;
	onClose: () => void;
}) {
	const [mode, setMode] = useState<Mode>("rotate");
	const [graceMinutes, setGraceMinutes] = useState(DEFAULT_GRACE_MINUTES);
	const [secret, setSecret] = useState("");
	const [rotated, setRotated] = useState<RotationResult | null>(null);
	const [done, setDone] = useState(false);

	const weak = secret.length === 0 ? undefined : weakSipSecretReason(secret);

	const rotate = useMutation({
		mutationFn: () => rotateExtensionSecret(extension.id, graceMinutes),
		onSuccess: (result) => setRotated(result),
	});
	const setByHand = useMutation({
		mutationFn: () => setExtensionSecret(extension.id, secret),
		onSuccess: () => {
			// Cleared the moment it is accepted: it is never shown again and does not belong in state.
			setSecret("");
			setDone(true);
		},
	});

	const mutation = mode === "rotate" ? rotate : setByHand;
	const finished = rotated !== null || done;

	if (finished) {
		return (
			<EntityFormDialog
				open
				onOpenChange={onClose}
				title={`Extension ${extension.number}`}
				submitLabel="Done"
				pending={false}
				error={null}
				onSubmit={onClose}
			>
				{rotated === null ? (
					<NoticeBanner
						title="New SIP password set"
						description="The extension authenticates with the new password from its next REGISTER. Any phone still holding the old one stops registering until it is re-provisioned."
					/>
				) : (
					<NoticeBanner
						title="A new SIP secret has been issued"
						description={
							rotated.graceUntil === null
								? "The previous secret stopped being accepted immediately. Any phone still holding it is offline until it re-provisions."
								: `The previous secret keeps working until ${new Date(rotated.graceUntil).toLocaleString()}. Until then both authenticate, which is the window a desk phone has to pick the new one up. After it, a phone still holding the old secret stops registering.`
						}
					/>
				)}
				<p className="text-sm text-muted-foreground">
					The password itself is derived from a key this screen never sees, so there is nothing to
					copy down — the phone receives it through provisioning.
				</p>
			</EntityFormDialog>
		);
	}

	return (
		<EntityFormDialog
			open
			onOpenChange={(next) => {
				if (!next) {
					onClose();
				}
			}}
			title={`Rotate the SIP secret for ${extension.number}`}
			description="Issue a new credential for this extension, or set its password by hand."
			submitLabel={mode === "rotate" ? "Rotate secret" : "Set password"}
			pending={mutation.isPending}
			error={mutation.error}
			onSubmit={() => {
				if (mode === "set" && weak !== undefined) {
					return;
				}
				mutation.mutate();
			}}
		>
			<fieldset className="flex flex-col gap-2">
				<legend className="text-sm font-medium text-foreground">What to do</legend>
				<Choice
					name="rotate-mode"
					checked={mode === "rotate"}
					onSelect={() => setMode("rotate")}
					label="Issue a new secret"
					hint="The platform generates it and the phone collects it through provisioning. Nothing to type, and nothing to write down."
				/>
				<Choice
					name="rotate-mode"
					checked={mode === "set"}
					onSelect={() => setMode("set")}
					label="Set the password by hand"
					hint="For a handset that cannot take a provisioned config, or a migration from another PBX. Takes effect at once — there is no grace period on this path."
				/>
			</fieldset>

			{mode === "rotate" ? (
				<fieldset className="flex flex-col gap-2">
					<legend className="text-sm font-medium text-foreground">
						How long the old secret keeps working
					</legend>
					<p className="text-xs text-muted-foreground">
						Until this deadline both secrets authenticate, so a desk phone can re-provision on its
						own schedule. After it, a phone still holding the old one stops registering — it goes
						offline rather than failing a call. Choose “immediately” when you are rotating because
						the credential leaked.
					</p>
					<div className="mt-1 flex flex-col gap-1.5">
						{GRACE_CHOICES.map((choice) => (
							<Choice
								key={choice.minutes}
								name="grace-minutes"
								checked={graceMinutes === choice.minutes}
								onSelect={() => setGraceMinutes(choice.minutes)}
								label={choice.label}
								hint={
									choice.minutes === 0
										? "The old secret stops being accepted the moment you confirm."
										: undefined
								}
							/>
						))}
					</div>
				</fieldset>
			) : (
				<div className="flex flex-col gap-1.5">
					<label htmlFor="sip-secret" className="text-sm font-medium text-foreground">
						New SIP password
					</label>
					<input
						id="sip-secret"
						type="password"
						value={secret}
						autoComplete="new-password"
						disabled={mutation.isPending}
						aria-invalid={weak !== undefined}
						aria-describedby="sip-secret-hint"
						onChange={(event) => setSecret(event.target.value)}
						className={cn(
							"h-9 max-w-md rounded-md border border-border bg-background px-3 text-sm",
							focusRing,
						)}
					/>
					<p id="sip-secret-hint" className="text-xs text-muted-foreground">
						At least {MIN_SIP_SECRET_LENGTH} characters, using at least three of: lower case, upper
						case, digits, other characters. There is no lockout on a SIP REGISTER, so an attacker
						works offline against a digest anybody can ask for — length is the only thing that costs
						them anything.
					</p>
					{weak === undefined ? null : (
						<p role="alert" className="text-xs text-danger">
							{weakSipSecretMessage(weak)}
						</p>
					)}
				</div>
			)}
		</EntityFormDialog>
	);
}

function Choice({
	name,
	checked,
	onSelect,
	label,
	hint,
}: {
	name: string;
	checked: boolean;
	onSelect: () => void;
	label: string;
	hint?: string;
}) {
	return (
		<label className="flex cursor-pointer items-start gap-2 text-sm text-foreground">
			<input
				type="radio"
				name={name}
				checked={checked}
				onChange={onSelect}
				className={cn("mt-0.5 size-4 shrink-0 accent-primary", focusRing)}
			/>
			<span className="flex flex-col gap-0.5">
				<span>{label}</span>
				{hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
			</span>
		</label>
	);
}
