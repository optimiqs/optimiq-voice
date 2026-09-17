"use client";

import { useState } from "react";
import { DeleteEntityDialog } from "~/components/pbx/delete-entity-dialog";
import {
	EnabledBadge,
	ListPagination,
	ListToolbar,
	ResourceTable,
	useListQueryState,
} from "~/components/pbx/resource-list";
import { RowActions } from "~/components/pbx/row-actions";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { DEFAULT_PAGE_LIMIT, PBX_RESOURCES } from "~/lib/pbx/client";
import { describeDestination, readDestination } from "~/lib/pbx/destinations";
import { usePermission } from "../../_context/session-context";
import { usePbxDelete, usePbxList } from "../../_hooks/use-pbx-queries";
import { AudioStreamDialog } from "./audio-stream-dialog";
import { DestinationAliasDialog } from "./destination-alias-dialog";
import { DirectoryDialog } from "./directory-dialog";
import { SpeedDialDialog } from "./speed-dial-dialog";
import type {
	AudioStreamRow,
	DestinationAliasRow,
	DialByNameDirectoryRow,
	SpeedDialRow,
} from "~/lib/pbx/contracts";

/**
 * The four list panels behind the Dial plan tabs.
 *
 * Each keeps its own URL state under a distinct prefix (`al`, `st`, `di`, `sd`), on the precedent
 * the Routing page set: one shared prefix would make searching the aliases silently page the speed
 * dials too, and a link to a filtered view has to survive a reload.
 *
 * All four are gated by the same `dial-plan.*` family — the permission registry's argument is that
 * none of them has a power profile of its own — so the permission checks below are deliberately
 * identical rather than parameterised. A reader checking "can this role delete a stream?" should
 * find the answer on the panel rather than in a shared helper.
 */

export function AliasesPanel() {
	const resource = PBX_RESOURCES.destinationAliases;
	const state = useListQueryState("al");
	const list = usePbxList(resource, state.query);
	const remove = usePbxDelete(resource);

	const canWrite = usePermission(resource.permissions.write);
	const canDelete = usePermission(resource.permissions.delete);

	const [editing, setEditing] = useState<DestinationAliasRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<DestinationAliasRow | null>(null);

	const createButton = canWrite ? (
		<Button
			variant="primary"
			onClick={() => {
				setEditing(null);
				setDialogOpen(true);
			}}
		>
			New named destination
		</Button>
	) : null;

	return (
		<>
			<ListToolbar
				search={state.search}
				onSearchChange={state.setSearch}
				enabledFilter={state.enabledFilter}
				onEnabledFilterChange={state.setEnabledFilter}
				searchPlaceholder="Name or description"
				action={createButton}
			/>

			<ResourceTable
				rows={list.rows}
				isPending={list.query.isPending}
				filtered={state.search.length > 0 || state.enabledFilter !== "all"}
				emptyTitle="No named destinations yet"
				emptyDescription="Give a place a name, point twenty routes at the name, and move the target with one edit instead of twenty."
				emptyAction={createButton}
				caption="Named destinations"
				columns={[
					{ key: "name", header: "Name", className: "font-medium", cell: (row) => row.name },
					{
						key: "target",
						header: "Points at",
						cell: (row) =>
							describeDestination(readDestination(row as unknown as Record<string, unknown>, "")),
					},
					{ key: "description", header: "Description", cell: (row) => row.description ?? "—" },
					{
						key: "enabled",
						header: "State",
						cell: (row) => <EnabledBadge enabled={row.enabled} />,
					},
				]}
				rowActions={(row) => (
					<RowActions
						label={`named destination ${row.name}`}
						onEdit={
							canWrite
								? () => {
										setEditing(row);
										setDialogOpen(true);
									}
								: undefined
						}
						onDelete={
							canDelete
								? () => {
										remove.reset();
										setPendingDelete(row);
									}
								: undefined
						}
					/>
				)}
			/>

			<ListPagination
				page={state.page}
				limit={DEFAULT_PAGE_LIMIT}
				total={list.total}
				totalPages={list.totalPages}
				onPageChange={state.setPage}
			/>

			<p className="text-xs text-muted-foreground">
				A named destination is not a step in the call: it compiles away flat, so routing through one
				behaves exactly as though the route had pointed at the target directly. Chains are followed,
				and a loop is refused after eight hops rather than compiled.
			</p>

			<DestinationAliasDialog
				key={editing?.id ?? "new"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				alias={editing}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="named destination"
				entityName={pendingDelete ? pendingDelete.name : "this named destination"}
				description="Everything pointing here must be re-pointed first — the delete is refused while one still does, because a dangling name would fail the next save on somebody else's unrelated change."
				pending={remove.isPending}
				error={remove.error}
				onConfirm={() => {
					if (!pendingDelete) {
						return;
					}
					remove.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) });
				}}
			/>
		</>
	);
}

export function StreamsPanel() {
	const resource = PBX_RESOURCES.audioStreams;
	const state = useListQueryState("st");
	const list = usePbxList(resource, state.query);
	const remove = usePbxDelete(resource);

	const canWrite = usePermission(resource.permissions.write);
	const canDelete = usePermission(resource.permissions.delete);

	const [editing, setEditing] = useState<AudioStreamRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<AudioStreamRow | null>(null);

	const createButton = canWrite ? (
		<Button
			variant="primary"
			onClick={() => {
				setEditing(null);
				setDialogOpen(true);
			}}
		>
			New audio stream
		</Button>
	) : null;

	return (
		<>
			<ListToolbar
				search={state.search}
				onSearchChange={state.setSearch}
				enabledFilter={state.enabledFilter}
				onEnabledFilterChange={state.setEnabledFilter}
				searchPlaceholder="Name or URL"
				action={createButton}
			/>

			<ResourceTable
				rows={list.rows}
				isPending={list.query.isPending}
				filtered={state.search.length > 0 || state.enabledFilter !== "all"}
				emptyTitle="No audio streams yet"
				emptyDescription="A stream sends a caller to a remote audio source — a radio feed, an information line — with somewhere to go when it ends."
				emptyAction={createButton}
				caption="Audio streams"
				columns={[
					{ key: "name", header: "Name", className: "font-medium", cell: (row) => row.name },
					{
						key: "url",
						header: "Source",
						className: "max-w-xs truncate font-mono text-xs",
						cell: (row) => row.url,
					},
					{
						key: "maxSeconds",
						header: "Plays for",
						cell: (row) => (
							<span className="text-sm text-muted-foreground" data-tabular>
								{row.maxSeconds === 0 ? "Until hangup" : `${row.maxSeconds}s`}
							</span>
						),
					},
					{
						key: "fallback",
						header: "Then goes to",
						cell: (row) =>
							describeDestination(
								readDestination(row as unknown as Record<string, unknown>, "fallback"),
							),
					},
					{
						key: "enabled",
						header: "State",
						cell: (row) => <EnabledBadge enabled={row.enabled} />,
					},
				]}
				rowActions={(row) => (
					<RowActions
						label={`audio stream ${row.name}`}
						onEdit={
							canWrite
								? () => {
										setEditing(row);
										setDialogOpen(true);
									}
								: undefined
						}
						onDelete={
							canDelete
								? () => {
										remove.reset();
										setPendingDelete(row);
									}
								: undefined
						}
					/>
				)}
			/>

			<ListPagination
				page={state.page}
				limit={DEFAULT_PAGE_LIMIT}
				total={list.total}
				totalPages={list.totalPages}
				onPageChange={state.setPage}
			/>

			<p className="text-xs text-muted-foreground">
				<Badge tone="warning">Not yet played</Badge> The engine has no remote-playback runtime, so a
				call that reaches a stream today hears the unavailable announcement and is released rather
				than taking the fallback. These rows compile, appear in call records as the destination the
				caller reached, and start playing when the media work lands — configuring them now is not
				wasted, but do not point a live number at one yet.
			</p>

			<AudioStreamDialog
				key={editing?.id ?? "new"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				stream={editing}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="audio stream"
				entityName={pendingDelete ? pendingDelete.name : "this stream"}
				description="Anything pointing at this stream must be re-pointed first — the delete is refused while one still does."
				pending={remove.isPending}
				error={remove.error}
				onConfirm={() => {
					if (!pendingDelete) {
						return;
					}
					remove.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) });
				}}
			/>
		</>
	);
}

export function DirectoriesPanel() {
	const resource = PBX_RESOURCES.directories;
	const state = useListQueryState("di");
	const list = usePbxList(resource, state.query);
	const remove = usePbxDelete(resource);

	const canWrite = usePermission(resource.permissions.write);
	const canDelete = usePermission(resource.permissions.delete);

	const [editing, setEditing] = useState<DialByNameDirectoryRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<DialByNameDirectoryRow | null>(null);

	const createButton = canWrite ? (
		<Button
			variant="primary"
			onClick={() => {
				setEditing(null);
				setDialogOpen(true);
			}}
		>
			New directory
		</Button>
	) : null;

	return (
		<>
			<ListToolbar
				search={state.search}
				onSearchChange={state.setSearch}
				enabledFilter={state.enabledFilter}
				onEnabledFilterChange={state.setEnabledFilter}
				searchPlaceholder="Name or number"
				action={createButton}
			/>

			<ResourceTable
				rows={list.rows}
				isPending={list.query.isPending}
				filtered={state.search.length > 0 || state.enabledFilter !== "all"}
				emptyTitle="No directories yet"
				emptyDescription="A directory lets a caller spell a colleague's name on the keypad. Who is in it is worked out from your extensions — there is no list to maintain."
				emptyAction={createButton}
				caption="Dial-by-name directories"
				columns={[
					{ key: "name", header: "Name", className: "font-medium", cell: (row) => row.name },
					{
						key: "extensionNumber",
						header: "Dial",
						className: "font-mono whitespace-nowrap",
						cell: (row) => row.extensionNumber ?? "—",
					},
					{
						key: "searchField",
						header: "Callers spell",
						cell: (row) =>
							row.searchField === "last-name"
								? "Surname"
								: row.searchField === "first-name"
									? "First name"
									: "Full name",
					},
					{
						key: "minDigits",
						header: "After",
						cell: (row) => (
							<span className="text-sm text-muted-foreground" data-tabular>
								{row.minDigits} digits
							</span>
						),
					},
					{
						key: "timeout",
						header: "Gives up to",
						cell: (row) =>
							describeDestination(
								readDestination(row as unknown as Record<string, unknown>, "timeout"),
							),
					},
					{
						key: "enabled",
						header: "State",
						cell: (row) => <EnabledBadge enabled={row.enabled} />,
					},
				]}
				rowActions={(row) => (
					<RowActions
						label={`directory ${row.name}`}
						onEdit={
							canWrite
								? () => {
										setEditing(row);
										setDialogOpen(true);
									}
								: undefined
						}
						onDelete={
							canDelete
								? () => {
										remove.reset();
										setPendingDelete(row);
									}
								: undefined
						}
					/>
				)}
			/>

			<ListPagination
				page={state.page}
				limit={DEFAULT_PAGE_LIMIT}
				total={list.total}
				totalPages={list.totalPages}
				onPageChange={state.setPage}
			/>

			<p className="text-xs text-muted-foreground">
				<Badge tone="warning">Not yet answered</Badge> Only extensions whose mailbox has a recorded
				name greeting can appear — there is no text-to-speech, so a name that cannot be spoken
				cannot be offered, and the rest are skipped with a warning when you save. The engine has no
				directory runtime yet either, so a call that reaches one today hears the unavailable
				announcement.
			</p>

			<DirectoryDialog
				key={editing?.id ?? "new"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				directory={editing}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="directory"
				entityName={pendingDelete ? pendingDelete.name : "this directory"}
				description="Anything pointing at this directory must be re-pointed first — the delete is refused while one still does. The extensions in it are untouched; they were never members."
				pending={remove.isPending}
				error={remove.error}
				onConfirm={() => {
					if (!pendingDelete) {
						return;
					}
					remove.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) });
				}}
			/>
		</>
	);
}

export function SpeedDialsPanel() {
	const resource = PBX_RESOURCES.speedDials;
	const state = useListQueryState("sd");
	const list = usePbxList(resource, state.query);
	const remove = usePbxDelete(resource);

	const canWrite = usePermission(resource.permissions.write);
	const canDelete = usePermission(resource.permissions.delete);

	const [editing, setEditing] = useState<SpeedDialRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<SpeedDialRow | null>(null);

	const createButton = canWrite ? (
		<Button
			variant="primary"
			onClick={() => {
				setEditing(null);
				setDialogOpen(true);
			}}
		>
			New speed dial
		</Button>
	) : null;

	return (
		<>
			<ListToolbar
				search={state.search}
				onSearchChange={state.setSearch}
				enabledFilter={state.enabledFilter}
				onEnabledFilterChange={state.setEnabledFilter}
				searchPlaceholder="Code or label"
				action={createButton}
			/>

			<ResourceTable
				rows={list.rows}
				isPending={list.query.isPending}
				filtered={state.search.length > 0 || state.enabledFilter !== "all"}
				emptyTitle="No speed dials yet"
				emptyDescription="A short code every handset can dial to reach one place — head office, the on-call phone, the warehouse."
				emptyAction={createButton}
				caption="Organization speed dials"
				columns={[
					{
						key: "code",
						header: "Dial",
						className: "font-mono font-medium whitespace-nowrap",
						cell: (row) => row.code,
					},
					{ key: "label", header: "Label", cell: (row) => row.label },
					{
						key: "target",
						header: "Reaches",
						cell: (row) =>
							describeDestination(readDestination(row as unknown as Record<string, unknown>, "")),
					},
					{
						key: "enabled",
						header: "State",
						cell: (row) => <EnabledBadge enabled={row.enabled} />,
					},
				]}
				rowActions={(row) => (
					<RowActions
						label={`speed dial ${row.code}`}
						onEdit={
							canWrite
								? () => {
										setEditing(row);
										setDialogOpen(true);
									}
								: undefined
						}
						onDelete={
							canDelete
								? () => {
										remove.reset();
										setPendingDelete(row);
									}
								: undefined
						}
					/>
				)}
			/>

			<ListPagination
				page={state.page}
				limit={DEFAULT_PAGE_LIMIT}
				total={list.total}
				totalPages={list.totalPages}
				onPageChange={state.setPage}
			/>

			<p className="text-xs text-muted-foreground">
				A speed dial reaches a destination, never a raw dial string — so a code pointing at an
				outside number still goes through your outbound routes and is screened and priced like any
				other call. Nothing can point at a speed dial, which is why they never appear in a
				destination picker.
			</p>

			<SpeedDialDialog
				key={editing?.id ?? "new"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				speedDial={editing}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="speed dial"
				entityName={pendingDelete ? pendingDelete.code : "this speed dial"}
				description="The code is freed. Handsets dialling it get whatever normal routing does with those digits, which is usually nothing."
				pending={remove.isPending}
				error={remove.error}
				onConfirm={() => {
					if (!pendingDelete) {
						return;
					}
					remove.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) });
				}}
			/>
		</>
	);
}
