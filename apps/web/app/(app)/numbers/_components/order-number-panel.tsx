"use client";

import { useState } from "react";
import { DestinationPicker } from "~/components/pbx/destination-picker";
import { ResourceTable } from "~/components/pbx/resource-list";
import { NoticeBanner } from "~/components/pbx/warnings-banner";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { Field, FieldDescription, FieldLabel, Input, Select } from "~/components/ui/field";
import { FormFooter } from "~/components/ui/form-footer";
import { DEFAULT_NUMBER_SEARCH_LIMIT } from "~/lib/carrier/client";
import {
	EMPTY_DESTINATION,
	validateDestinationValue,
	writeDestination,
} from "~/lib/pbx/destinations";
import { usePermission } from "../../_context/session-context";
import {
	useAvailableNumbers,
	useCarrierStatus,
	useOrderNumber,
} from "../../_hooks/use-carrier-queries";
import type { AvailableNumber } from "~/lib/carrier/client";
import type { DestinationValue } from "~/lib/pbx/destinations";

/**
 * Buying a DID: search the carrier's inventory, pick one, say where it should ring.
 *
 * ## The search is a deliberate act, not a page load
 *
 * It does not run on mount. A search is a live call to the carrier, and every number it returns is
 * one the carrier now treats as orderable by this account — so it happens when someone asks for it.
 * That is also why there is a Search button rather than a debounced input: this is not filtering a
 * list we already have.
 *
 * ## Ordering asks for a destination before it spends anything
 *
 * The API requires the destination trio on the order for the same reason `POST /phone-numbers`
 * requires it: a number that costs money every month and routes nowhere is the worst version of
 * "this DID rings nothing". So the confirmation is a small form rather than a yes/no — and it is a
 * form the user fills in BEFORE the money moves, not a follow-up they might abandon.
 */

const COUNTRIES = [
	{ code: "US", label: "United States" },
	{ code: "CA", label: "Canada" },
	{ code: "GB", label: "United Kingdom" },
	{ code: "AU", label: "Australia" },
	{ code: "DE", label: "Germany" },
	{ code: "NL", label: "Netherlands" },
] as const;

const NUMBER_TYPES = [
	{ value: "local", label: "Local" },
	{ value: "toll_free", label: "Toll free" },
	{ value: "national", label: "National" },
	{ value: "mobile", label: "Mobile" },
] as const;

function formatCost(entry: AvailableNumber): string {
	if (entry.monthlyCost === null) {
		return "—";
	}
	const currency = entry.currency ?? "";
	return `${entry.monthlyCost} ${currency}/mo`.trim();
}

export function OrderNumberPanel() {
	const status = useCarrierStatus();
	const canOrder = usePermission("numbers.order");

	const [country, setCountry] = useState("US");
	const [areaCode, setAreaCode] = useState("");
	const [contains, setContains] = useState("");
	const [numberType, setNumberType] = useState<string>("local");
	// Bumped on every submit so a repeated search with unchanged criteria still refetches — the
	// carrier's inventory moves even when the form does not.
	const [submitted, setSubmitted] = useState<number>(0);

	const search = useAvailableNumbers(
		{
			country,
			areaCode: areaCode.trim() === "" ? undefined : areaCode.trim(),
			contains: contains.trim() === "" ? undefined : contains.trim(),
			numberType,
			limit: DEFAULT_NUMBER_SEARCH_LIMIT,
		},
		{ enabled: submitted > 0 && status.data?.configured === true },
	);

	const [ordering, setOrdering] = useState<AvailableNumber | null>(null);

	if (status.isPending) {
		return null;
	}

	if (status.data?.configured !== true) {
		return (
			<NoticeBanner
				title="No carrier connected"
				description={
					<>
						This deployment has no carrier configured, so numbers cannot be bought here. An operator
						needs to set <code className="font-mono text-xs">TELNYX_API_KEY</code> on the API.
						Numbers you already own keep working, and you can still add a DID by hand from the
						Numbers tab.
					</>
				}
			/>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			{canOrder ? null : (
				<NoticeBanner
					title="Read only"
					description="You can see what is available, but ordering a number adds a recurring charge and needs the “Order numbers” permission."
				/>
			)}

			<form
				className="grid gap-3 rounded-panel border border-border bg-surface p-4 sm:grid-cols-2 lg:grid-cols-5"
				onSubmit={(event) => {
					event.preventDefault();
					setSubmitted((count) => count + 1);
				}}
			>
				<Field>
					<FieldLabel htmlFor="carrier-country">Country</FieldLabel>
					<Select
						id="carrier-country"
						value={country}
						onChange={(event) => setCountry(event.target.value)}
					>
						{COUNTRIES.map((entry) => (
							<option key={entry.code} value={entry.code}>
								{entry.label}
							</option>
						))}
					</Select>
				</Field>

				<Field>
					<FieldLabel htmlFor="carrier-area-code">Area code</FieldLabel>
					<Input
						id="carrier-area-code"
						inputMode="numeric"
						placeholder="212"
						value={areaCode}
						onChange={(event) => setAreaCode(event.target.value.replace(/\D/gu, ""))}
					/>
					<FieldDescription>Optional.</FieldDescription>
				</Field>

				<Field>
					<FieldLabel htmlFor="carrier-contains">Contains</FieldLabel>
					<Input
						id="carrier-contains"
						inputMode="numeric"
						placeholder="5555"
						value={contains}
						onChange={(event) => setContains(event.target.value.replace(/\D/gu, ""))}
					/>
					<FieldDescription>Digits anywhere in the number.</FieldDescription>
				</Field>

				<Field>
					<FieldLabel htmlFor="carrier-type">Type</FieldLabel>
					<Select
						id="carrier-type"
						value={numberType}
						onChange={(event) => setNumberType(event.target.value)}
					>
						{NUMBER_TYPES.map((entry) => (
							<option key={entry.value} value={entry.value}>
								{entry.label}
							</option>
						))}
					</Select>
				</Field>

				<div className="flex items-end">
					<Button type="submit" variant="primary" loading={search.query.isFetching}>
						Search
					</Button>
				</div>
			</form>

			<ResourceTable
				rows={search.rows.map((entry) => ({ ...entry, id: entry.e164 }))}
				isPending={submitted > 0 && search.query.isPending}
				filtered={submitted > 0}
				emptyTitle={submitted === 0 ? "Search for a number" : "Nothing matched"}
				emptyDescription={
					submitted === 0
						? "Pick a country and, if you like, an area code or digits the number should contain. Results come live from the carrier."
						: "The carrier has nothing available for those criteria right now. Try a different area code, or drop the “contains” filter."
				}
				caption="Numbers available from the carrier"
				columns={[
					{
						key: "e164",
						header: "Number",
						className: "font-medium whitespace-nowrap",
						cell: (row) => row.e164,
					},
					{ key: "region", header: "Region", cell: (row) => row.region ?? "—" },
					{
						key: "cost",
						header: "Cost",
						className: "whitespace-nowrap tabular-nums",
						cell: (row) => formatCost(row),
					},
					{
						key: "features",
						header: "Capabilities",
						cell: (row) => (
							<div className="flex flex-wrap gap-1">
								{row.features.map((feature) => (
									<Badge key={feature} tone={feature === "voice" ? "accent" : "neutral"}>
										{feature}
									</Badge>
								))}
							</div>
						),
					},
				]}
				rowActions={(row) =>
					canOrder ? (
						<Button variant="secondary" onClick={() => setOrdering(row)}>
							Order
						</Button>
					) : null
				}
			/>

			<OrderNumberDialog
				key={ordering?.e164 ?? "none"}
				number={ordering}
				onClose={() => setOrdering(null)}
			/>
		</div>
	);
}

/**
 * The confirmation, which is a form because the order needs a destination.
 *
 * A plain "are you sure?" would leave the destination to a follow-up edit, and a DID that arrives
 * routed nowhere is one that bills from the moment it exists and rings for nobody until somebody
 * remembers. The cost is restated here rather than only in the table, because this is the click
 * that spends it.
 */
function OrderNumberDialog({
	number,
	onClose,
}: {
	number: AvailableNumber | null;
	onClose: () => void;
}) {
	const order = useOrderNumber();
	const [destination, setDestination] = useState<DestinationValue>(EMPTY_DESTINATION);
	const [label, setLabel] = useState("");
	const [error, setError] = useState<string | null>(null);

	function submit(): void {
		if (number === null) {
			return;
		}
		const invalid = validateDestinationValue(destination, { required: true });
		if (invalid !== undefined) {
			setError(invalid.message);
			return;
		}
		setError(null);
		order.mutate(
			{
				e164: number.e164,
				label: label.trim() === "" ? null : label.trim(),
				...(writeDestination(destination, "") as {
					destinationType: string;
					destinationRef?: string | null;
					destinationData?: unknown;
				}),
			},
			{ onSuccess: () => onClose() },
		);
	}

	return (
		<Dialog
			open={number !== null}
			onOpenChange={(next) => {
				if (!next) {
					order.reset();
					onClose();
				}
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Order {number?.e164}</DialogTitle>
					<DialogDescription>
						{number === null
							? ""
							: `This adds a recurring charge of ${formatCost(number)} to your account, starting now. Choose where calls to it should go — a number with no destination bills every month and rings for nobody.`}
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-4 py-2">
					<Field>
						<FieldLabel htmlFor="order-label">Label</FieldLabel>
						<Input
							id="order-label"
							placeholder="Support line"
							value={label}
							onChange={(event) => setLabel(event.target.value)}
						/>
						<FieldDescription>Optional. Only you see it.</FieldDescription>
					</Field>

					<DestinationPicker
						prefix=""
						label="Default destination"
						description="Where a call to this number goes when no inbound route claims it."
						value={destination}
						onChange={(next) => {
							setDestination(next);
							setError(null);
						}}
						required
					/>

					{error === null ? null : (
						<p
							role="alert"
							className="rounded-panel border border-danger/40 bg-danger-subtle px-3 py-2 text-sm text-foreground"
						>
							{error}
						</p>
					)}
				</div>

				<DialogFooter>
					<FormFooter
						submitLabel="Order number"
						loading={order.isPending}
						loadingLabel="Ordering…"
						submitType="button"
						onCancel={() => {
							order.reset();
							onClose();
						}}
						onSubmit={submit}
					/>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
