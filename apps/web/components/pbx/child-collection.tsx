"use client";

import { Button } from "../ui/button";
import { Card, CardBody, CardDescription, CardFooter, CardHeader, CardTitle } from "../ui/card";
import { EmptyState } from "../ui/empty-state";
import { LoadingPanel } from "../ui/spinner";
import {
	Table,
	TableBody,
	TableCell,
	TableContainer,
	TableHead,
	TableHeader,
	TableRow,
} from "../ui/table";
import type { ResourceTableColumn } from "./resource-list";
import type { ReactNode } from "react";

/**
 * The panel an ordered child collection lives in — IVR options, ring-group members, time rules.
 *
 * All three are the same shape: a small ordered list, each entry carrying its own destination, no
 * pagination (the API does not paginate them, deliberately — a menu with more than a screenful of
 * options is a design problem, not a paging problem). So the panel is shared and only the columns
 * and the editor dialog differ.
 *
 * The empty state is where the compiler's warnings and this UI meet: an IVR with no options and a
 * ring group with no members both compile to something that answers nothing, and both produce a
 * warning on save. Saying so here — before the save — is cheaper than saying it after.
 */
export function ChildCollectionCard<TRow extends { readonly id: string }>({
	title,
	description,
	rows,
	columns,
	isPending,
	emptyTitle,
	emptyDescription,
	addLabel,
	onAdd,
	rowActions,
	footer,
}: {
	title: string;
	description?: ReactNode;
	rows: readonly TRow[];
	columns: readonly ResourceTableColumn<TRow>[];
	isPending: boolean;
	emptyTitle: string;
	emptyDescription: string;
	addLabel: string;
	/** Absent when the caller may not write, which removes the button rather than disabling it. */
	onAdd?: () => void;
	rowActions?: (row: TRow) => ReactNode;
	footer?: ReactNode;
}) {
	return (
		<Card>
			<CardHeader>
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div className="flex min-w-0 flex-col gap-1">
						<CardTitle>{title}</CardTitle>
						{description ? <CardDescription>{description}</CardDescription> : null}
					</div>
					{onAdd ? (
						<Button size="sm" variant="secondary" onClick={onAdd}>
							{addLabel}
						</Button>
					) : null}
				</div>
			</CardHeader>
			<CardBody className="p-0">
				{isPending ? (
					<LoadingPanel label={`Loading ${title.toLowerCase()}`} />
				) : rows.length === 0 ? (
					<EmptyState
						className="rounded-none border-0"
						title={emptyTitle}
						description={emptyDescription}
						action={
							onAdd ? (
								<Button variant="primary" onClick={onAdd}>
									{addLabel}
								</Button>
							) : null
						}
					/>
				) : (
					<TableContainer className="rounded-none border-0">
						<Table>
							<TableHeader>
								<TableRow>
									{columns.map((column) => (
										<TableHead key={column.key} className={column.headerClassName}>
											{column.header}
										</TableHead>
									))}
									{rowActions ? (
										<TableHead className="w-0">
											<span className="sr-only">Actions</span>
										</TableHead>
									) : null}
								</TableRow>
							</TableHeader>
							<TableBody>
								{rows.map((row) => (
									<TableRow key={row.id}>
										{columns.map((column) => (
											<TableCell key={column.key} className={column.className}>
												{column.cell(row)}
											</TableCell>
										))}
										{rowActions ? (
											<TableCell className="text-right whitespace-nowrap">
												{rowActions(row)}
											</TableCell>
										) : null}
									</TableRow>
								))}
							</TableBody>
						</Table>
					</TableContainer>
				)}
			</CardBody>
			{footer ? <CardFooter className="justify-start">{footer}</CardFooter> : null}
		</Card>
	);
}
