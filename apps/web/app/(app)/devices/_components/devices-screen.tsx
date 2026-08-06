"use client";

import { parseAsStringLiteral, useQueryState } from "nuqs";
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
import { NoticeBanner } from "~/components/pbx/warnings-banner";
import { ConfirmDialog } from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { MenuItem } from "~/components/ui/menu";
import { PageHeader } from "~/components/ui/page-header";
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTrigger } from "~/components/ui/tabs";
import { DEFAULT_PAGE_LIMIT } from "~/lib/pbx/client";
import { PROVISIONING_RESOURCES } from "~/lib/provisioning/client";
import {
	VENDOR_LABELS,
	formatMacAddress,
	type DeviceProfileRow,
	type DeviceRow,
	type ProvisioningTokenResult,
} from "~/lib/provisioning/contracts";
import { DEVICE_TABS, type DeviceTab } from "~/lib/routes";
import { usePermission } from "../../_context/session-context";
import { usePbxDelete, usePbxList } from "../../_hooks/use-pbx-queries";
import {
	useProvisioningCatalog,
	useRegenerateProvisioningToken,
} from "../../_hooks/use-provisioning-queries";
import { DeviceDialog } from "./device-dialog";
import { DeviceProfileDialog } from "./device-profile-dialog";
import { ProvisioningUrlPanel } from "./provisioning-url-panel";

/**
 * Devices, and the profiles they share.
 *
 * ## Two sections on one page rather than two sidebar entries
 *
 * A profile is not a thing an administrator sets out to manage — it is a thing they reach for while
 * managing devices, which is why it lives behind a tab here rather than as a second entry that
 * would be a second way to say "phones". Same reasoning, and the same `?tab=` mechanism, as the
 * Routing page's four sections and the Numbers page's two.
 *
 * ## The provisioning URL is a page-level panel, not a toast
 *
 * A newly minted URL exists in exactly one HTTP response and cannot be re-read. A toast disappears
 * on a timer; a dialog closes on a stray click outside it. So the panel is rendered into the page
 * above the table, where it stays until the administrator dismisses it — which is the same shape
 * the trunk detail page uses for a SIP password, and for the same reason.
 */
const TAB_LABELS: Readonly<Record<DeviceTab, string>> = {
	devices: "Devices",
	profiles: "Profiles",
};

export function DevicesScreen() {
	const [tab, setTab] = useQueryState(
		"tab",
		parseAsStringLiteral(DEVICE_TABS).withDefault("devices").withOptions({ clearOnDefault: true }),
	);
	const catalog = useProvisioningCatalog();
	const [minted, setMinted] = useState<ProvisioningTokenResult | null>(null);

	return (
		<>
			<PageHeader
				title="Devices"
				description="Desk phones and softphones, their line assignments and the settings they are provisioned with."
			/>

			{catalog.data?.configured === false ? (
				<NoticeBanner
					title="Phones cannot fetch a configuration yet"
					description={
						<>
							Devices can be recorded and their lines assigned now, but a phone requesting its
							configuration gets a 503 until an operator sets{" "}
							<code className="font-mono text-xs">{catalog.data.missing.join(" and ")}</code> on the
							API.
						</>
					}
				/>
			) : null}

			{minted ? (
				<ProvisioningUrlPanel provisioning={minted} onDismiss={() => setMinted(null)} />
			) : null}

			<Tabs value={tab} onValueChange={(next) => void setTab(next as DeviceTab)}>
				<TabsList>
					{DEVICE_TABS.map((value) => (
						<TabsTrigger key={value} value={value}>
							{TAB_LABELS[value]}
						</TabsTrigger>
					))}
					<TabsIndicator />
				</TabsList>

				<TabsPanel value="devices">
					<DevicesSection onMinted={setMinted} />
				</TabsPanel>
				<TabsPanel value="profiles">
					<ProfilesSection />
				</TabsPanel>
			</Tabs>
		</>
	);
}

function DevicesSection({ onMinted }: { onMinted: (result: ProvisioningTokenResult) => void }) {
	const resource = PROVISIONING_RESOURCES.devices;
	const { query, search, setSearch, enabledFilter, setEnabledFilter, page, setPage } =
		useListQueryState();
	const list = usePbxList(resource, query);
	const remove = usePbxDelete(resource);

	const canWrite = usePermission(resource.permissions.write);
	const canDelete = usePermission(resource.permissions.delete);

	const [editing, setEditing] = useState<DeviceRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<DeviceRow | null>(null);
	const [rotating, setRotating] = useState<DeviceRow | null>(null);

	const createButton = canWrite ? (
		<Button
			variant="primary"
			onClick={() => {
				setEditing(null);
				setDialogOpen(true);
			}}
		>
			New device
		</Button>
	) : null;

	return (
		<div className="flex flex-col gap-4">
			<ListToolbar
				search={search}
				onSearchChange={setSearch}
				enabledFilter={enabledFilter}
				onEnabledFilterChange={setEnabledFilter}
				searchPlaceholder="MAC address, label or model"
				action={createButton}
			/>

			<ResourceTable
				rows={list.rows}
				isPending={list.query.isPending}
				filtered={search.length > 0 || enabledFilter !== "all"}
				emptyTitle="No devices yet"
				emptyDescription="Add the MAC address printed on the bottom of a phone, assign it an extension, and enter the provisioning URL into the handset."
				emptyAction={createButton}
				caption="Devices in this organization"
				columns={[
					{
						key: "macAddress",
						header: "MAC",
						className: "font-mono text-sm whitespace-nowrap",
						cell: (row) => formatMacAddress(row.macAddress),
					},
					{
						key: "label",
						header: "Label",
						className: "font-medium",
						cell: (row) => row.label ?? "—",
					},
					{
						key: "vendor",
						header: "Vendor",
						cell: (row) => (
							<div className="flex flex-wrap items-center gap-1">
								<Badge tone={row.vendor === "generic" ? "neutral" : "accent"}>
									{VENDOR_LABELS[row.vendor]}
								</Badge>
								{row.model ? (
									<span className="text-xs text-muted-foreground">{row.model}</span>
								) : null}
							</div>
						),
					},
					{
						key: "lastProvisionedAt",
						header: "Last check-in",
						cell: (row) =>
							row.lastProvisionedAt === null ? (
								<span className="text-sm text-muted-foreground">Never</span>
							) : (
								<span className="text-sm text-muted-foreground" data-tabular>
									{new Date(row.lastProvisionedAt).toLocaleString()}
								</span>
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
						label={`device ${formatMacAddress(row.macAddress)}`}
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
						extra={
							canWrite ? (
								<MenuItem onClick={() => setRotating(row)}>Rotate provisioning URL</MenuItem>
							) : undefined
						}
					/>
				)}
			/>

			<ListPagination
				page={page}
				limit={DEFAULT_PAGE_LIMIT}
				total={list.total}
				totalPages={list.totalPages}
				onPageChange={setPage}
			/>

			<DeviceDialog
				key={editing?.id ?? "new"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				device={editing}
				onCreated={(result) => onMinted(result.provisioning)}
			/>

			{rotating ? (
				<RotateTokenDialog
					device={rotating}
					onClose={() => setRotating(null)}
					onRotated={(result) => {
						onMinted(result);
						setRotating(null);
					}}
				/>
			) : null}

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="device"
				entityName={pendingDelete ? formatMacAddress(pendingDelete.macAddress) : "this device"}
				description="Its provisioning URL stops working immediately. The phone keeps whatever configuration it last fetched until it is factory reset, so unplug it or reset it as well."
				pending={remove.isPending}
				error={remove.error}
				onConfirm={() => {
					if (!pendingDelete) {
						return;
					}
					remove.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) });
				}}
			/>
		</div>
	);
}

/**
 * The rotation confirmation.
 *
 * Its own component so the mutation hook can be keyed to one device — `useMutation` needs the id at
 * construction, and a hook at the section level would either rebuild on every row hover or need the
 * id threaded through the mutate call, which is a worse shape for something that revokes a
 * credential.
 */
function RotateTokenDialog({
	device,
	onClose,
	onRotated,
}: {
	device: DeviceRow;
	onClose: () => void;
	onRotated: (result: ProvisioningTokenResult) => void;
}) {
	const rotate = useRegenerateProvisioningToken(device.id);

	return (
		<ConfirmDialog
			open
			onOpenChange={(open) => {
				if (!open) {
					onClose();
				}
			}}
			title="Rotate this device's provisioning URL?"
			description={
				device.lastProvisionedAt === null
					? "The current URL stops working immediately. This phone has never checked in, so nothing is disrupted — but any URL you already wrote down becomes invalid."
					: "The current URL stops working immediately. This phone has already fetched a configuration and will keep running on it, but it will not pick up any further change until the new URL is entered into the handset."
			}
			confirmLabel="Rotate"
			pending={rotate.isPending}
			onConfirm={() => {
				rotate.mutate({}, { onSuccess: (result) => onRotated(result.provisioning) });
			}}
		/>
	);
}

function ProfilesSection() {
	const resource = PROVISIONING_RESOURCES.deviceProfiles;
	const { query, search, setSearch, enabledFilter, setEnabledFilter, page, setPage } =
		useListQueryState("profile-");
	const list = usePbxList(resource, query);
	const remove = usePbxDelete(resource);

	const canWrite = usePermission(resource.permissions.write);
	const canDelete = usePermission(resource.permissions.delete);

	const [editing, setEditing] = useState<DeviceProfileRow | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<DeviceProfileRow | null>(null);

	const createButton = canWrite ? (
		<Button
			variant="primary"
			onClick={() => {
				setEditing(null);
				setDialogOpen(true);
			}}
		>
			New profile
		</Button>
	) : null;

	return (
		<div className="flex flex-col gap-4">
			<ListToolbar
				search={search}
				onSearchChange={setSearch}
				enabledFilter={enabledFilter}
				onEnabledFilterChange={setEnabledFilter}
				searchPlaceholder="Name or model"
				action={createButton}
			/>

			<ResourceTable
				rows={list.rows}
				isPending={list.query.isPending}
				filtered={search.length > 0 || enabledFilter !== "all"}
				emptyTitle="No device profiles yet"
				emptyDescription="A profile is the settings a group of identical phones shares. Change it once and every device that uses it changes at its next check-in."
				emptyAction={createButton}
				caption="Device profiles in this organization"
				columns={[
					{ key: "name", header: "Name", className: "font-medium", cell: (row) => row.name },
					{
						key: "vendor",
						header: "Applies to",
						cell: (row) => (
							<span className="text-sm text-muted-foreground">
								{VENDOR_LABELS[row.vendor]}
								{row.model ? ` · ${row.model}` : " · every model"}
							</span>
						),
					},
					{
						key: "settings",
						header: "Settings",
						cell: (row) => (
							<span className="text-sm text-muted-foreground" data-tabular>
								{Object.keys(row.settings ?? {}).length}
							</span>
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
						label={`device profile ${row.name}`}
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
				page={page}
				limit={DEFAULT_PAGE_LIMIT}
				total={list.total}
				totalPages={list.totalPages}
				onPageChange={setPage}
			/>

			<DeviceProfileDialog
				key={editing?.id ?? "new"}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				profile={editing}
			/>

			<DeleteEntityDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
						remove.reset();
					}
				}}
				entityLabel="device profile"
				entityName={pendingDelete?.name ?? "this profile"}
				description="The delete is refused while any device still points at it — otherwise every one of those phones would quietly lose the settings this profile gave them."
				pending={remove.isPending}
				error={remove.error}
				onConfirm={() => {
					if (!pendingDelete) {
						return;
					}
					remove.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) });
				}}
			/>
		</div>
	);
}
