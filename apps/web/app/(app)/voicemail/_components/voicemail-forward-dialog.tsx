"use client";

import { useEffect, useState } from "react";
import { ResourceSelect } from "~/components/pbx/resource-select";
import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { forwardModeCopy, forwardTargetError } from "~/lib/pbx/voicemail-forward";
import { useForwardVoicemailMessage } from "../../_hooks/use-voicemail-queries";
import type { VoicemailForwardMode, VoicemailMessageRow } from "~/lib/pbx/contracts";

/**
 * Send one message to another mailbox.
 *
 * ## Why the mailbox picker is `ResourceSelect` and not a list of "my" mailboxes
 *
 * The destination is any mailbox in the organization — forwarding to a colleague is the point of
 * the feature, and a picker narrowed to the boxes the caller owns would only ever offer their own.
 * `ResourceSelect` is already the tenant-scoped, searchable, hundred-row-capped select every other
 * reference field on this app uses, and the API's `voicemail-boxes` list is what it reads: a
 * self-service user sees their own boxes plus nothing they are not entitled to SEE, and the
 * forward's own authorisation is the server's, not this select's.
 *
 * ## The mode is chosen by the caller, not by the dialog
 *
 * "Forward…" and "Copy to…" are two row actions and one dialog, because the only thing that differs
 * is one sentence and one button label — see `lib/pbx/voicemail-forward.ts`, where both live so they
 * cannot drift apart. What does NOT differ is the destination question, which is why there is one
 * picker rather than two dialogs that would each have to keep it in step.
 *
 * A recorded introduction is out of scope: prepending a fresh recording to the forwarded audio needs
 * a recording leg on the call path, which is `apps/engine`'s and which nothing in the browser can
 * fabricate.
 */
export function VoicemailForwardDialog({
	open,
	onOpenChange,
	sourceBoxId,
	message,
	mode,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	sourceBoxId: string;
	message: VoicemailMessageRow | null;
	mode: VoicemailForwardMode;
}) {
	const [targetBoxId, setTargetBoxId] = useState("");
	const [touched, setTouched] = useState(false);
	const forward = useForwardVoicemailMessage();

	// A fresh choice per opening. Keeping the previous destination would make the second forward of
	// a session one careless press away from a mailbox the user is no longer thinking about.
	useEffect(() => {
		if (open) {
			setTargetBoxId("");
			setTouched(false);
		}
	}, [open]);

	const copy = forwardModeCopy(mode);
	const error = forwardTargetError(sourceBoxId, targetBoxId);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="w-[min(32rem,calc(100vw-2rem))]">
				<DialogHeader>
					<DialogTitle>{copy.title}</DialogTitle>
					<DialogDescription>{copy.description}</DialogDescription>
				</DialogHeader>

				<ResourceSelect
					id="voicemail-forward-target"
					label="Destination mailbox"
					description="Any mailbox in this organization."
					resource={PBX_RESOURCES.voicemailBoxes}
					value={targetBoxId}
					onChange={(next) => {
						setTouched(true);
						setTargetBoxId(next);
					}}
					allowEmpty={false}
					placeholder="Choose a mailbox…"
					disabled={forward.isPending}
					{...(touched && error !== undefined ? { error } : {})}
				/>

				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)} disabled={forward.isPending}>
						Cancel
					</Button>
					<Button
						variant="primary"
						disabled={error !== undefined || message === null || forward.isPending}
						onClick={() => {
							setTouched(true);
							if (error !== undefined || message === null) {
								return;
							}
							forward.mutate(
								{ boxId: sourceBoxId, messageId: message.id, targetBoxId, mode },
								{ onSuccess: () => onOpenChange(false) },
							);
						}}
					>
						{copy.confirm}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
