"use client";

import Link from "next/link";
import { Button } from "../ui/button";
import { Menu, MenuContent, MenuItem, MenuLinkItem, MenuSeparator, MenuTrigger } from "../ui/menu";
import type { ReactNode } from "react";

/**
 * The per-row action menu.
 *
 * A menu rather than a row of buttons: a table with edit and delete on every row spends two
 * controls per row on actions that are used once in fifty, and puts a destructive button one
 * mis-click from every row. The trigger carries its own label — an icon-only control in a table
 * is otherwise announced as "button" fifty times.
 *
 * Actions the caller may not perform are not passed in at all rather than disabled: a disabled
 * "Delete" invites the question "why", and the answer (a permission) is not something the row can
 * explain.
 */
export function RowActions({
	label,
	onEdit,
	onDelete,
	detailHref,
	detailLabel = "Open",
	extra,
}: {
	/** Names the row, e.g. "extension 1001". Used for the menu's accessible name. */
	label: string;
	onEdit?: () => void;
	onDelete?: () => void;
	detailHref?: string;
	detailLabel?: string;
	extra?: ReactNode;
}) {
	const hasDestructive = onDelete !== undefined;
	if (!onEdit && !onDelete && !detailHref && !extra) {
		return null;
	}

	return (
		<Menu>
			<MenuTrigger
				render={
					<Button size="sm" variant="ghost" aria-label={`Actions for ${label}`}>
						Actions
					</Button>
				}
			/>
			<MenuContent align="end">
				{detailHref ? (
					<MenuLinkItem render={<Link href={detailHref} />}>{detailLabel}</MenuLinkItem>
				) : null}
				{onEdit ? <MenuItem onClick={onEdit}>Edit</MenuItem> : null}
				{extra}
				{hasDestructive && (onEdit || detailHref || extra) ? <MenuSeparator /> : null}
				{onDelete ? (
					<MenuItem onClick={onDelete} className="text-danger data-[highlighted]:bg-danger-subtle">
						Delete
					</MenuItem>
				) : null}
			</MenuContent>
		</Menu>
	);
}
