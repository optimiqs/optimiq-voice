"use client";

import Link from "next/link";
import { useState } from "react";
import { ChildCollectionCard } from "~/components/pbx/child-collection";
import { DeleteEntityDialog } from "~/components/pbx/delete-entity-dialog";
import { EnabledBadge } from "~/components/pbx/resource-list";
import { RowActions } from "~/components/pbx/row-actions";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { EmptyState } from "~/components/ui/empty-state";
import { PageHeader } from "~/components/ui/page-header";
import { LoadingPanel } from "~/components/ui/spinner";
import { ApiError } from "~/lib/api-client";
import { PBX_CHILDREN, PBX_RESOURCES } from "~/lib/pbx/client";
import { describeDestination, readDestination } from "~/lib/pbx/destinations";
import { routes } from "~/lib/routes";
import { usePermission } from "../../_context/session-context";
import { usePbxChildDelete, usePbxChildren, usePbxItem } from "../../_hooks/use-pbx-queries";
import { IvrMenuDialog } from "./ivr-menu-dialog";
import { IvrOptionDialog } from "./ivr-option-dialog";
import type { IvrMenuOptionRow, IvrMenuRow } from "~/lib/pbx/contracts";

/**
 * One IVR menu and its digit options.
 *
 * The options are the menu. A menu without them answers, waits, and takes its timeout branch —
 * which is exactly what the compiler warns about on save, so the empty state here says the same
 * thing in the same words rather than leaving the user to discover it from a toast.
 */
export function IvrMenuDetail({ menuId }: { menuId: string }) {
	const menu = usePbxItem(PBX_RESOURCES.ivrMenus, menuId);
	const options = usePbxChildren(PBX_CHILDREN.ivrOptions, "ivr-menus", menuId);
	const removeOption = usePbxChildDelete(PBX_CHILDREN.ivrOptions, "ivr-menus", menuId);

	const canWrite = usePermission(PBX_RESOURCES.ivrMenus.permissions.write);

	const [menuDialogOpen, setMenuDialogOpen] = useState(false);
	const [editingOption, setEditingOption] = useState<IvrMenuOptionRow | null>(null);
	const [optionDialogOpen, setOptionDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<IvrMenuOptionRow | null>(null);

	if (menu.isPending) {
		return <LoadingPanel label="Loading menu" />;
	}

	if (menu.error instanceof ApiError && menu.error.status === 404) {
		return (
			<EmptyState
				title="This menu no longer exists"
				description="It may have been deleted from another session."
				action={
					<Button render={<Link href={routes.ivr} />} variant="secondary">
						Back to IVR menus
					</Button>
				}
			/>
		);
	}

	if (!menu.data) {
		return (
			<EmptyState
				title="Could not load this menu"
				description={menu.error instanceof Error ? menu.error.message : "Try again in a moment."}
			/>
		);
	}

	const row = menu.data as IvrMenuRow;
	const rows = options.data ?? [];
	const nextOrdinal = rows.reduce((highest, option) => Math.max(highest, option.ordinal + 1), 0);

	function openAddOption(): void {
		setEditingOption(null);
		setOptionDialogOpen(true);
	}

	return (
		<>
			<PageHeader
				title={row.name}
				description={
					row.extensionNumber
						? `Dialable internally on ${row.extensionNumber}.`
						: "Reached only by whatever routes calls into it."
				}
				actions={
					<div className="flex items-center gap-2">
						<Button render={<Link href={routes.ivr} />} variant="ghost">
							All menus
						</Button>
						{canWrite ? (
							<Button variant="secondary" onClick={() => setMenuDialogOpen(true)}>
								Menu settings
							</Button>
						) : null}
					</div>
				}
			/>

			<Card>
				<CardHeader>
					<CardTitle>Fallbacks</CardTitle>
					<CardDescription>
						Where the caller goes when they do not choose an option.
					</CardDescription>
				</CardHeader>
				<CardBody className="grid gap-4 sm:grid-cols-2">
					<Fallback
						label="After silence"
						detail={`${row.maxTimeouts} attempt${row.maxTimeouts === 1 ? "" : "s"}, ${row.digitTimeoutMs}ms each`}
						destination={describeDestination(
							readDestination(row as unknown as Record<string, unknown>, "timeout"),
						)}
					/>
					<Fallback
						label="After a wrong entry"
						detail={`${row.maxFailures} attempt${row.maxFailures === 1 ? "" : "s"}`}
						destination={describeDestination(
							readDestination(row as unknown as Record<string, unknown>, "invalid"),
						)}
					/>
				</CardBody>
			</Card>

			<ChildCollectionCard
				title="Options"
				description="What the caller may press, in the order the engine tries them."
				rows={rows}
				isPending={options.isPending}
				emptyTitle="No options yet"
				emptyDescription="Without an option, this menu answers, waits out its timeout and takes the silence branch. The routing compiler will say the same thing next time you save."
				addLabel="Add option"
				onAdd={canWrite ? openAddOption : undefined}
				columns={[
					{
						key: "matchValue",
						header: "Press",
						className: "font-medium whitespace-nowrap",
						cell: (option) => (
							<span className="flex items-center gap-2">
								<span className="font-mono">{option.matchValue}</span>
								{option.matchKind === "regex" ? <Badge tone="neutral">pattern</Badge> : null}
							</span>
						),
					},
					{ key: "label", header: "For", cell: (option) => option.label ?? "—" },
					{
						key: "destination",
						header: "Goes to",
						cell: (option) =>
							describeDestination(
								readDestination(option as unknown as Record<string, unknown>, ""),
							),
					},
					{ key: "ordinal", header: "Order", cell: (option) => option.ordinal },
					{
						key: "enabled",
						header: "State",
						cell: (option) => <EnabledBadge enabled={option.enabled} />,
					},
				]}
				rowActions={(option) => (
					<RowActions
						label={`option ${option.matchValue}`}
						onEdit={
							canWrite
								? () => {
										setEditingOption(option);
										setOptionDialogOpen(true);
									}
								: undefined
						}
						onDelete={
							canWrite
								? () => {
										removeOption.reset();
										setPendingDelete(option);
									}
								: undefined
						}
					/>
				)}
			/>

			<IvrMenuDialog open={menuDialogOpen} onOpenChange={setMenuDialogOpen} menu={row} />

			<IvrOptionDialog
				key={editingOption?.id ?? `new-${nextOrdinal}`}
				open={optionDialogOpen}
				onOpenChange={setOptionDialogOpen}
				menuId={menuId}
				option={editingOption}
				nextOrdinal={nextOrdinal}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						removeOption.reset();
					}
				}}
				entityLabel="option"
				entityName={pendingDelete ? `option ${pendingDelete.matchValue}` : "this option"}
				description="Callers pressing this key will fall through to the invalid branch instead."
				pending={removeOption.isPending}
				error={removeOption.error}
				onConfirm={() => {
					if (!pendingDelete) {
						return;
					}
					removeOption.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) });
				}}
			/>
		</>
	);
}

function Fallback({
	label,
	detail,
	destination,
}: {
	label: string;
	detail: string;
	destination: string;
}) {
	return (
		<div className="flex flex-col gap-0.5">
			<span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
				{label}
			</span>
			<span className="text-sm text-foreground">{destination}</span>
			<span className="text-xs text-muted-foreground">{detail}</span>
		</div>
	);
}
