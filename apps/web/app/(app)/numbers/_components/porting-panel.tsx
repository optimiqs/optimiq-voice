"use client";

import { useState } from "react";
import { ResourceTable } from "~/components/pbx/resource-list";
import { NoticeBanner } from "~/components/pbx/warnings-banner";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
	Field,
	FieldDescription,
	FieldLabel,
	Input,
	Select,
	Textarea,
} from "~/components/ui/field";
import { SwitchRow } from "~/components/ui/switch";
import { MAX_CNAM_DETAILS_LENGTH, MAX_PORT_NUMBERS } from "~/lib/carrier/client";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { usePermission } from "../../_context/session-context";
import {
	useCarrierStatus,
	useCnamListing,
	useCreatePortingOrder,
	usePortingOrders,
	useUpdateCnamListing,
} from "../../_hooks/use-carrier-queries";
import { usePbxList } from "../../_hooks/use-pbx-queries";
import type { PortingOrder } from "~/lib/carrier/client";

/**
 * Bringing a number with you, and controlling the name it shows.
 *
 * ## Why these two share a tab
 *
 * They look unrelated and they are the same conversation. Someone porting a number in is moving
 * their identity to this platform, and the caller-ID name the called party sees is the other half
 * of that identity — the pair of them is "our number, our name". Separating them would produce two
 * screens that each answer half of the only question anyone actually arrives with.
 *
 * ## A port in flight is not a number you own
 *
 * Nothing here creates a `phone_number` row, and the panel says so in as many words. A ported
 * number still routes to the losing carrier until the FOC date, and a DID listed under "Your
 * numbers" that silently drops every call would be a far more expensive lie than an empty list.
 * The port appears in the table below; the number appears in the Numbers tab once it cuts over.
 *
 * ## The statuses are labelled, not enumerated
 *
 * `STATUS_TONES` maps the states we know about and falls back to neutral for anything else. The
 * carrier can add a lifecycle state — the API deliberately does not refuse one it has not heard of
 * — and a screen that crashed or showed a blank cell on an unrecognised status would break exactly
 * when a port is doing something unusual, which is the moment someone is looking at it.
 */

const STATUS_TONES: Readonly<Record<string, "accent" | "neutral" | "danger" | "success">> = {
	draft: "neutral",
	"in-process": "accent",
	submitted: "accent",
	"foc-date-confirmed": "accent",
	"cancel-pending": "neutral",
	exception: "danger",
	ported: "success",
	cancelled: "neutral",
};

/** What a status means, in the words of someone waiting on it rather than the carrier's. */
const STATUS_HELP: Readonly<Record<string, string>> = {
	draft: "Filed, not yet with the losing carrier. It usually needs paperwork.",
	"in-process": "The losing carrier is working through it.",
	submitted: "With the losing carrier, waiting on a date.",
	"foc-date-confirmed": "A cutover date is confirmed. Nothing changes until then.",
	"cancel-pending": "A cancellation is being processed.",
	exception: "Stalled. The losing carrier rejected something and a human has to answer.",
	ported: "Done. The number is live here.",
	cancelled: "Cancelled. The number stays where it was.",
};

function formatDate(value: string | null): string {
	if (value === null) {
		return "—";
	}
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString();
}

/**
 * Splits the pasted block into E.164 candidates.
 *
 * A textarea rather than a repeatable field, because the input people actually have is a column
 * pasted out of their current provider's portal. Splitting on any run of non-number characters
 * means newlines, commas and tabs all work without the user being told which one to use.
 */
function parseNumbers(raw: string): readonly string[] {
	return raw
		.split(/[^0-9+]+/u)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

export function PortingPanel() {
	const status = useCarrierStatus();
	const canPort = usePermission("numbers.order");
	const canRead = usePermission("numbers.read");

	if (status.isPending) {
		return null;
	}

	if (status.data?.configured !== true) {
		return (
			<NoticeBanner
				title="No carrier connected"
				description={
					<>
						This deployment has no carrier configured, so a number cannot be ported in and caller ID
						names cannot be changed here. An operator needs to set{" "}
						<code className="font-mono text-xs">TELNYX_API_KEY</code> on the API.
					</>
				}
			/>
		);
	}

	return (
		<div className="flex flex-col gap-6">
			<PortInForm canPort={canPort} />
			<PortingOrdersTable />
			{canRead ? <CnamSection /> : null}
		</div>
	);
}

// ---------------------------------------------------------------------------------------------
// Porting
// ---------------------------------------------------------------------------------------------

function PortInForm({ canPort }: { canPort: boolean }) {
	const port = useCreatePortingOrder();
	const [raw, setRaw] = useState("");
	const [error, setError] = useState<string | null>(null);

	const numbers = parseNumbers(raw);
	const malformed = numbers.filter((entry) => !/^\+[1-9]\d{7,14}$/u.test(entry));

	function submit(): void {
		if (numbers.length === 0) {
			setError("Enter at least one number, in full international form.");
			return;
		}
		if (malformed.length > 0) {
			// Named rather than counted: "3 numbers are invalid" sends someone hunting through their
			// own paste for which three.
			setError(`Not in international form: ${malformed.slice(0, 3).join(", ")}`);
			return;
		}
		if (numbers.length > MAX_PORT_NUMBERS) {
			setError(`At most ${MAX_PORT_NUMBERS} numbers per port.`);
			return;
		}
		setError(null);
		port.mutate({ e164s: numbers }, { onSuccess: () => setRaw("") });
	}

	return (
		<section className="flex flex-col gap-3 rounded-panel border border-border bg-surface p-4">
			<div>
				<h2 className="text-sm font-medium text-foreground">Port a number in</h2>
				<p className="mt-1 text-xs text-muted-foreground">
					Bring a number you already have from another provider. Filing a port does not add the
					number here — it still rings at your old provider until the cutover date, and it appears
					under “Your numbers” once it does. Keep the old service running until then.
				</p>
			</div>

			{canPort ? null : (
				<NoticeBanner
					title="Read only"
					description="You can see ports in flight, but filing one commits to a recurring charge and needs the “Order numbers” permission."
				/>
			)}

			<Field>
				<FieldLabel htmlFor="port-numbers">Numbers</FieldLabel>
				<Textarea
					id="port-numbers"
					rows={4}
					placeholder={"+13125551234\n+13125551235"}
					value={raw}
					disabled={!canPort}
					onChange={(event) => setRaw(event.target.value)}
				/>
				<FieldDescription>
					One per line, in full international form. Commas and tabs work too, so a column pasted
					from your current provider’s portal is fine.
					{numbers.length > 0 ? ` ${numbers.length} recognised.` : ""}
				</FieldDescription>
			</Field>

			{error === null ? null : <p className="text-xs text-danger">{error}</p>}

			<div className="flex justify-end">
				<Button
					variant="primary"
					disabled={!canPort}
					loading={port.isPending}
					onClick={() => submit()}
				>
					File the port
				</Button>
			</div>
		</section>
	);
}

function PortingOrdersTable() {
	const ports = usePortingOrders();
	const rows: readonly PortingOrder[] = ports.data?.data ?? [];

	return (
		<ResourceTable
			rows={[...rows]}
			isPending={ports.isPending}
			filtered={false}
			emptyTitle="No ports in flight"
			emptyDescription="Numbers you are bringing over from another provider show up here, with the cutover date once the losing carrier confirms one."
			caption="Ports in flight"
			columns={[
				{
					key: "numbers",
					header: "Numbers",
					className: "font-medium whitespace-nowrap",
					cell: (row) =>
						row.e164s.length <= 2
							? row.e164s.join(", ")
							: `${row.e164s[0]} +${row.numberCount - 1}`,
				},
				{
					key: "status",
					header: "Status",
					cell: (row) => (
						<div className="flex flex-col gap-0.5">
							<Badge tone={STATUS_TONES[row.status] ?? "neutral"}>{row.status}</Badge>
							{STATUS_HELP[row.status] === undefined ? null : (
								<span className="text-xs text-muted-foreground">{STATUS_HELP[row.status]}</span>
							)}
						</div>
					),
				},
				{
					key: "foc",
					header: "Cutover",
					className: "whitespace-nowrap",
					cell: (row) => formatDate(row.focDatetime),
				},
				{
					/**
					 * The one carrier-side string on this screen, and it earns its place: it is what the
					 * losing carrier's support desk asks for when a port stalls, and a customer who cannot
					 * read it off their own dashboard cannot resolve the stall.
					 */
					key: "supportKey",
					header: "Support key",
					className: "font-mono text-xs whitespace-nowrap",
					cell: (row) => row.supportKey ?? "—",
				},
				{
					key: "filed",
					header: "Filed",
					className: "whitespace-nowrap",
					cell: (row) => formatDate(row.createdAt),
				},
			]}
		/>
	);
}

// ---------------------------------------------------------------------------------------------
// CNAM
// ---------------------------------------------------------------------------------------------

/**
 * The name a called party sees, per number.
 *
 * Only carrier-managed DIDs are offered. A hand-entered or BYO number has nothing at the carrier
 * whose listing could change, and the API refuses it — so listing it here would be an invitation
 * to a 422. The empty state says which numbers qualify rather than just saying "none".
 */
function CnamSection() {
	const list = usePbxList(PBX_RESOURCES.phoneNumbers, { page: 1, limit: 100 });
	const managed = list.rows.filter(
		(row) => row.carrierProvider !== null && row.carrierRef !== null,
	);
	const [selected, setSelected] = useState<string | null>(null);
	const active = selected ?? managed[0]?.id ?? null;

	if (list.query.isPending) {
		return null;
	}

	if (managed.length === 0) {
		return (
			<NoticeBanner
				title="No carrier-managed numbers"
				description="A caller ID name can only be set on a number this platform bought or ported. A DID you entered by hand is configured with whoever owns it."
			/>
		);
	}

	return (
		<section className="flex flex-col gap-3 rounded-panel border border-border bg-surface p-4">
			<div>
				<h2 className="text-sm font-medium text-foreground">Caller ID name (CNAM)</h2>
				<p className="mt-1 text-xs text-muted-foreground">
					The name shown to people you call. Carriers refresh their CNAM databases on their own
					schedule, so a change can take a few days to appear on every network.
				</p>
			</div>

			<Field>
				<FieldLabel htmlFor="cnam-number">Number</FieldLabel>
				<Select
					id="cnam-number"
					value={active ?? ""}
					onChange={(event) => setSelected(event.target.value)}
				>
					{managed.map((row) => (
						<option key={row.id} value={row.id}>
							{row.e164}
							{row.label === null ? "" : ` — ${row.label}`}
						</option>
					))}
				</Select>
			</Field>

			{active === null ? null : <CnamForm key={active} phoneNumberId={active} />}
		</section>
	);
}

function CnamForm({ phoneNumberId }: { phoneNumberId: string }) {
	const listing = useCnamListing(phoneNumberId);
	const save = useUpdateCnamListing(phoneNumberId);
	const canWrite = usePermission("numbers.write");

	/**
	 * The form is seeded from the query and then owned locally, keyed on the number id by the
	 * caller — so switching numbers remounts with fresh values rather than leaving a half-typed
	 * name from the previous one sitting in a field labelled with a different DID.
	 */
	const [draft, setDraft] = useState<{
		enabled: boolean;
		listingEnabled: boolean;
		details: string;
	} | null>(null);

	if (listing.isPending) {
		return null;
	}
	if (listing.data === undefined) {
		return (
			<NoticeBanner
				title="Could not read the listing"
				description="The carrier did not answer. Try again in a moment."
			/>
		);
	}

	const current = draft ?? {
		enabled: listing.data.enabled,
		listingEnabled: listing.data.listingEnabled,
		details: listing.data.listingDetails ?? "",
	};

	return (
		<div className="flex flex-col gap-3">
			<SwitchRow
				id="cnam-enabled"
				label="Present a name on outbound calls"
				description="Off means calls from this number show the number only."
				checked={current.enabled}
				disabled={!canWrite}
				onCheckedChange={(checked) => setDraft({ ...current, enabled: checked })}
			/>
			<SwitchRow
				id="cnam-listing-enabled"
				label="Keep a listing in the CNAM database"
				description="The record other carriers look the name up in. This is billed separately by most carriers."
				checked={current.listingEnabled}
				disabled={!canWrite}
				onCheckedChange={(checked) => setDraft({ ...current, listingEnabled: checked })}
			/>

			<Field>
				<FieldLabel htmlFor="cnam-details">Name</FieldLabel>
				<Input
					id="cnam-details"
					maxLength={MAX_CNAM_DETAILS_LENGTH}
					placeholder="ACME LTD"
					value={current.details}
					disabled={!canWrite}
					onChange={(event) => setDraft({ ...current, details: event.target.value })}
				/>
				<FieldDescription>
					{MAX_CNAM_DETAILS_LENGTH} characters, printable ASCII — the width of the CNAM field
					itself, not our limit. {current.details.length}/{MAX_CNAM_DETAILS_LENGTH} used.
				</FieldDescription>
			</Field>

			{canWrite ? (
				<div className="flex justify-end">
					<Button
						variant="primary"
						loading={save.isPending}
						disabled={draft === null}
						onClick={() =>
							save.mutate(
								{
									enabled: current.enabled,
									listingEnabled: current.listingEnabled,
									details: current.details,
								},
								{ onSuccess: () => setDraft(null) },
							)
						}
					>
						Save
					</Button>
				</div>
			) : (
				<NoticeBanner
					title="Read only"
					description="Changing the caller ID name needs the “Manage numbers” permission."
				/>
			)}
		</div>
	);
}
