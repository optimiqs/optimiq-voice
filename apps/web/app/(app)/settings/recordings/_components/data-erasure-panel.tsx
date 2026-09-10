"use client";

import { useId, useState } from "react";
import { Button } from "~/components/ui/button";
import {
	Card,
	CardBody,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "~/components/ui/card";
import { inputClassName } from "~/components/ui/field";
import { erasureBody, erasureConfirmMatches, isEmptyErasure } from "~/lib/cdr/erasure";
import { cn } from "~/lib/cn";
import { usePreviewErasure, useApplyErasure } from "../../../_hooks/use-cdr-queries";
import type { ErasureCounts, ErasureSelector } from "~/lib/cdr/erasure";

/**
 * Honouring a "delete everything you hold about me" request, from the screen that already owns the
 * organization's recording posture.
 *
 * ## Why it is fenced off rather than folded into the form above
 *
 * Everything above this panel is a POLICY: it changes what happens to calls made from now on and
 * can be changed back. This is an ACT, aimed at one person, and it cannot be undone. Those are
 * different enough that they get different permissions on the server — `recordings.configure`
 * against `recordings.delete` — and putting them in one card would put an irreversible button in
 * the tab order of a settings form.
 *
 * ## Why the subject has to be typed twice
 *
 * The rest of the product destroys things you picked off a list; this destroys things matched
 * against a value you typed. A transposed digit erases a different person's recordings and reports
 * success, and nothing afterwards can tell you it happened. So the flow is preview → read the
 * counts → re-type the subject → erase, and the destructive button does not exist until the two
 * agree. See {@link erasureConfirmMatches}.
 *
 * ## What it destroys and what it keeps, said before the button
 *
 * Recordings and voicemail are destroyed, object first and then the row. Call records SURVIVE with
 * the numbers replaced by a hash and the names, SIP call id and raw payload cleared — which is what
 * keeps billing counts and queue statistics right after an erasure. An operator who expected the
 * call history to empty out would otherwise conclude the erasure had failed.
 */
export function DataErasurePanel() {
	const selectorId = useId();
	const subjectId = useId();
	const confirmId = useId();

	const [selector, setSelector] = useState<ErasureSelector>("phoneNumber");
	const [subject, setSubject] = useState("");
	const [confirmation, setConfirmation] = useState("");
	/** The subject the preview below was actually run for, which is what the confirm is checked against. */
	const [previewed, setPreviewed] = useState<string | null>(null);
	const [erased, setErased] = useState<ErasureCounts | null>(null);

	const preview = usePreviewErasure();
	const apply = useApplyErasure();
	const pending = preview.isPending || apply.isPending;

	const counts = preview.data ?? null;
	const confirmed = previewed !== null && erasureConfirmMatches(previewed, confirmation);

	/** Any edit to the subject invalidates the preview: the counts below would be about someone else. */
	function changeSubject(next: string): void {
		setSubject(next);
		setPreviewed(null);
		setConfirmation("");
		setErased(null);
		preview.reset();
		apply.reset();
	}

	return (
		<Card className="border-danger/40">
			<CardHeader>
				<CardTitle>Erase a person&apos;s data</CardTitle>
				<CardDescription>
					For a right-to-erasure request. Every recording and voicemail message this organization
					holds for one number or extension is destroyed — the audio first, then the row. Call
					records are <strong className="font-medium text-foreground">kept</strong>, with the
					numbers replaced by a one-way hash and the names, SIP call id and raw payload cleared, so
					billing counts and queue statistics stay right. This cannot be undone.
				</CardDescription>
			</CardHeader>

			<CardBody className="space-y-5">
				<div className="flex flex-wrap items-end gap-3">
					<div className="flex flex-col gap-1.5">
						<label htmlFor={selectorId} className="text-xs font-medium text-muted-foreground">
							Identify them by
						</label>
						<select
							id={selectorId}
							value={selector}
							onChange={(event) => {
								setSelector(event.target.value as ErasureSelector);
								changeSubject("");
							}}
							disabled={pending}
							className={cn(inputClassName, "w-48 pr-8")}
						>
							<option value="phoneNumber">Phone number</option>
							<option value="extension">Extension</option>
						</select>
					</div>

					<div className="flex min-w-56 flex-1 flex-col gap-1.5">
						<label htmlFor={subjectId} className="text-xs font-medium text-muted-foreground">
							{selector === "phoneNumber" ? "Phone number" : "Extension"}
						</label>
						<input
							id={subjectId}
							type="text"
							value={subject}
							onChange={(event) => changeSubject(event.target.value)}
							disabled={pending}
							placeholder={selector === "phoneNumber" ? "+12125550100" : "1001"}
							aria-describedby={`${subjectId}-description`}
							className={inputClassName}
						/>
						<p id={`${subjectId}-description`} className="text-xs text-muted-foreground">
							{selector === "phoneNumber"
								? "Full E.164, including the country code. A national number is refused rather than guessed at — guessing a country would erase the records of whoever holds that number there."
								: "The extension number exactly as this organization assigned it."}
						</p>
					</div>

					<Button
						type="button"
						variant="secondary"
						loading={preview.isPending}
						disabled={subject.trim().length === 0 || pending}
						onClick={() => {
							const value = subject.trim();
							apply.reset();
							setErased(null);
							setConfirmation("");
							preview.mutate(erasureBody(selector, value), {
								onSuccess: () => setPreviewed(value),
							});
						}}
					>
						Preview
					</Button>
				</div>

				{erased === null && counts !== null && previewed !== null ? (
					<div className="flex flex-col gap-4">
						<ErasureCountsList
							counts={counts}
							caption={`What an erasure would affect for ${previewed}`}
						/>

						{isEmptyErasure(counts) ? (
							<p className="max-w-prose text-sm text-muted-foreground">
								This organization holds nothing for {previewed}. There is nothing to erase.
							</p>
						) : (
							<div className="flex max-w-prose flex-col gap-1.5 rounded-panel border border-danger/40 bg-danger-subtle px-4 py-3">
								<label htmlFor={confirmId} className="text-sm font-medium text-foreground">
									Type {previewed} again to confirm
								</label>
								<input
									id={confirmId}
									type="text"
									value={confirmation}
									onChange={(event) => setConfirmation(event.target.value)}
									disabled={pending}
									autoComplete="off"
									aria-describedby={`${confirmId}-description`}
									className={inputClassName}
								/>
								<p id={`${confirmId}-description`} className="text-xs text-muted-foreground">
									The recordings and voicemail below are destroyed immediately. Nothing restores
									them.
								</p>
							</div>
						)}
					</div>
				) : null}

				{erased !== null ? (
					<ErasureCountsList
						counts={erased}
						caption={
							isEmptyErasure(erased)
								? "Nothing was left to erase"
								: `Erased for ${previewed ?? "this person"}`
						}
					/>
				) : null}
			</CardBody>

			<CardFooter>
				<Button
					type="button"
					variant="danger"
					loading={apply.isPending}
					disabled={!confirmed || counts === null || isEmptyErasure(counts) || pending}
					onClick={() => {
						if (previewed === null) {
							return;
						}
						apply.mutate(erasureBody(selector, previewed), {
							onSuccess: (result) => {
								setErased(result);
								setConfirmation("");
								preview.reset();
							},
						});
					}}
				>
					Erase permanently
				</Button>
			</CardFooter>
		</Card>
	);
}

/**
 * The four counts, as a description list rather than a table.
 *
 * Four labelled numbers are a set of facts about one subject, not rows of anything, and a `<dl>`
 * is what a screen reader announces as label-then-value. The objects count is deliberately last and
 * worded as media files: it is the only line that is about the store rather than the database, and
 * it is what proves the audio itself went rather than just its row.
 */
function ErasureCountsList({ counts, caption }: { counts: ErasureCounts; caption: string }) {
	return (
		<section aria-label={caption} className="flex flex-col gap-2">
			<p className="text-sm font-medium text-foreground">{caption}</p>
			<dl className="grid gap-3 sm:grid-cols-4">
				<Count label="Recordings" value={counts.recordings} />
				<Count label="Voicemail messages" value={counts.voicemailMessages} />
				<Count label="Call records kept, numbers hashed" value={counts.callLegs} />
				<Count label="Media files" value={counts.objects} />
			</dl>
		</section>
	);
}

function Count({ label, value }: { label: string; value: number }) {
	return (
		<div className="rounded-panel border border-border bg-muted/30 px-4 py-3">
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="text-lg font-medium text-foreground" data-tabular>
				{value.toLocaleString()}
			</dd>
		</div>
	);
}
