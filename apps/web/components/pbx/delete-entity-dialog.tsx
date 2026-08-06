"use client";

import Link from "next/link";
import { pbxReferences } from "~/lib/pbx/errors";
import { referenceHref, referenceKindLabel, referenceLabel } from "~/lib/pbx/references";
import { ConfirmDialog } from "../ui/alert-dialog";
import type { ReactNode } from "react";

/**
 * The one delete confirmation the PBX area uses.
 *
 * ## The 409 is the interesting case
 *
 * `destination_ref` has no foreign key — its target table varies by row — so referential
 * integrity is the application's job, and the API refuses a delete that would leave a dangling
 * destination with a `PBX_REFERENCED` 409 naming the referrers. That refusal is a FEATURE: the
 * alternative is three IVR options quietly pointing at nothing until an unrelated save fails the
 * next compile.
 *
 * So the failure is not a toast and not a dismissal. The dialog stays open, keeps the delete
 * button live, and renders each referrer as a link to where it can be re-pointed. Anything less
 * turns "here are the four things to fix" into "it did not work".
 */
export function DeleteEntityDialog({
	open,
	onOpenChange,
	entityLabel,
	entityName,
	description,
	pending,
	error,
	onConfirm,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Singular, lower case: "extension", "ring group". */
	entityLabel: string;
	entityName: string;
	/** What deleting actually does, beyond removing the row. */
	description: ReactNode;
	pending: boolean;
	/** The last failure, if the delete has already been attempted. */
	error: unknown;
	onConfirm: () => void;
}) {
	const references = pbxReferences(error);

	return (
		<ConfirmDialog
			open={open}
			onOpenChange={onOpenChange}
			title={`Delete ${entityName}?`}
			description={description}
			details={references.length > 0 ? <ReferenceList references={references} /> : null}
			confirmLabel={`Delete ${entityLabel}`}
			destructive
			pending={pending}
			onConfirm={onConfirm}
		/>
	);
}

function ReferenceList({
	references,
}: {
	references: readonly {
		readonly kind: string;
		readonly id: string;
		readonly name: string | null;
		readonly field: string;
	}[];
}) {
	return (
		<section
			aria-label="Rows that still point here"
			className="flex flex-col gap-2 rounded-panel border border-danger/40 bg-danger-subtle px-4 py-3"
		>
			<p className="text-sm font-medium text-foreground">
				{references.length === 1
					? "One row still points here."
					: `${references.length} rows still point here.`}{" "}
				Re-point or delete them first.
			</p>
			<ul className="flex flex-col gap-1">
				{references.map((reference) => {
					const href = referenceHref(reference);
					const label = `${referenceKindLabel(reference.kind)} · ${referenceLabel(reference)}`;
					return (
						<li key={`${reference.kind}-${reference.id}-${reference.field}`} className="text-sm">
							{href ? (
								<Link href={href} className="text-primary underline-offset-4 hover:underline">
									{label}
								</Link>
							) : (
								<span className="text-foreground">{label}</span>
							)}
						</li>
					);
				})}
			</ul>
		</section>
	);
}
