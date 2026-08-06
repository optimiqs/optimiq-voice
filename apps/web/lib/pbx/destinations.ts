/**
 * The destination vocabulary, as the admin UI needs it.
 *
 * A destination is stored as a column TRIO — `{ …destinationType, …destinationRef,
 * …destinationData }` — prefixed by which slot on the row it occupies (`""`, `"failover"`,
 * `"timeout"`, `"invalid"`, `"nomatch"`). Eleven trio sites across seven entities all mean the
 * same thing, so the shape of one is described once here and `DestinationPicker` renders it.
 *
 * Every entity-backed type now has a list endpoint behind it. `queue`, `conference` and `park` did
 * not until their CRUD landed, and until then offering them here would have produced a ref the user
 * could not populate and the compiler would have rejected as dangling on the very next save — so
 * they were shown only when a row already carried one. {@link selectableDestinationTypes} still
 * enforces that rule; it simply no longer excludes anything, and it is what keeps a future
 * entity-backed type from being offered before it has somewhere to point.
 */

import { PBX_RESOURCES } from "./client";
import { DESTINATION_TYPE_KINDS, DESTINATION_TYPES } from "./contracts";
import type { PbxResourceDescriptor } from "./client";
import type { DestinationData, DestinationKind, DestinationType } from "./contracts";

/** Which slot of a row a trio occupies. `""` is the row's primary destination. */
export type DestinationPrefix = "" | "failover" | "timeout" | "invalid" | "nomatch";

export interface DestinationFieldNames {
	readonly type: string;
	readonly ref: string;
	readonly data: string;
}

/**
 * The three form field names of one trio.
 *
 * These are the exact strings the API puts in a `PBX_INVALID_DESTINATION` issue and in a compile
 * diagnostic's `field`, which is what lets a server error land on the control that produced it
 * without a translation table.
 */
export function destinationFieldNames(prefix: DestinationPrefix): DestinationFieldNames {
	return prefix === ""
		? { type: "destinationType", ref: "destinationRef", data: "destinationData" }
		: {
				type: `${prefix}DestinationType`,
				ref: `${prefix}DestinationRef`,
				data: `${prefix}DestinationData`,
			};
}

export const DESTINATION_TYPE_LABELS: Readonly<Record<DestinationType, string>> = {
	extension: "Extension",
	ivr: "IVR menu",
	"ring-group": "Ring group",
	queue: "Queue",
	voicemail: "Voicemail box",
	conference: "Conference",
	park: "Park lot",
	"time-condition": "Time condition",
	external: "External number",
	application: "Engine application",
	hangup: "Hang up",
};

/**
 * A list endpoint the entity picker can page through, with its rows widened.
 *
 * The picker holds several target resources at once and renders whichever the selected type
 * names, so it cannot be generic over one row type. Widening happens HERE, once, inside
 * {@link target} — where the concrete `displayName` is still in scope — rather than with a cast
 * at every call site.
 */
export interface DestinationTargetResource {
	readonly key: string;
	readonly path: string;
	readonly label: string;
	readonly labelPlural: string;
	readonly displayName: (row: Record<string, unknown>) => string;
}

function target<TRow>(resource: PbxResourceDescriptor<TRow>): DestinationTargetResource {
	return {
		key: resource.key,
		path: resource.path,
		label: resource.label,
		labelPlural: resource.labelPlural,
		displayName: (row) => resource.displayName(row as TRow),
	};
}

/**
 * The list endpoint that populates the entity picker for a type, or `undefined` when the type is
 * not entity-backed. Every entity-backed type has one; a new one that does not is simply not
 * offered, rather than offered and unpopulatable.
 */
const DESTINATION_TARGETS: Partial<Record<DestinationType, DestinationTargetResource>> = {
	extension: target(PBX_RESOURCES.extensions),
	ivr: target(PBX_RESOURCES.ivrMenus),
	"ring-group": target(PBX_RESOURCES.ringGroups),
	queue: target(PBX_RESOURCES.queues),
	voicemail: target(PBX_RESOURCES.voicemailBoxes),
	conference: target(PBX_RESOURCES.conferences),
	park: target(PBX_RESOURCES.parkLots),
	"time-condition": target(PBX_RESOURCES.timeConditions),
};

export function destinationTarget(type: DestinationType): DestinationTargetResource | undefined {
	return DESTINATION_TARGETS[type];
}

export function destinationKind(type: DestinationType): DestinationKind {
	return DESTINATION_TYPE_KINDS[type];
}

/**
 * The types a picker may offer, plus whichever type the current value already holds.
 *
 * Keeping the current value in the list is what stops an edit form from silently rewriting a
 * seeded `queue` destination into whatever happens to be first in the select.
 */
export function selectableDestinationTypes(
	current: DestinationType | null | undefined,
): readonly DestinationType[] {
	return DESTINATION_TYPES.filter(
		(type) =>
			type === current ||
			destinationKind(type) !== "entity" ||
			destinationTarget(type) !== undefined,
	);
}

/** The value of one trio, as a form holds it. */
export interface DestinationValue {
	readonly type: DestinationType | null;
	readonly ref: string | null;
	readonly data: DestinationData | null;
}

export const EMPTY_DESTINATION: DestinationValue = { type: null, ref: null, data: null };

/** Reads a trio off a row, whatever prefix it lives under. */
export function readDestination(
	row: Readonly<Record<string, unknown>> | null | undefined,
	prefix: DestinationPrefix,
): DestinationValue {
	if (!row) {
		return EMPTY_DESTINATION;
	}
	const names = destinationFieldNames(prefix);
	const type = row[names.type];
	return {
		type: typeof type === "string" ? (type as DestinationType) : null,
		ref: typeof row[names.ref] === "string" ? (row[names.ref] as string) : null,
		data: (row[names.data] ?? null) as DestinationData | null,
	};
}

/**
 * Flattens a trio back onto a request body, dropping the half its kind does not use.
 *
 * This is the guard that keeps `z.strictObject` happy and keeps the check constraint in
 * `pbx-db` from refusing the row: an `external` destination that still carries the `ref` left
 * over from when the user had `extension` selected is a 422 with `unexpected-ref`, and the user
 * never chose it — the select did.
 */
export function writeDestination(
	value: DestinationValue,
	prefix: DestinationPrefix,
): Record<string, unknown> {
	const names = destinationFieldNames(prefix);
	if (value.type === null) {
		// `null` on a PATCH means "clear it"; on a POST the API treats an explicit null the same.
		return { [names.type]: null, [names.ref]: null, [names.data]: null };
	}

	const kind = destinationKind(value.type);
	if (kind === "entity") {
		return {
			[names.type]: value.type,
			[names.ref]: value.ref,
			[names.data]: normalizeData(value.data, "args"),
		};
	}
	if (kind === "value") {
		return {
			[names.type]: value.type,
			[names.ref]: null,
			[names.data]: normalizeData(value.data, "value"),
		};
	}
	return {
		[names.type]: value.type,
		[names.ref]: null,
		[names.data]: normalizeData(value.data, "cause"),
	};
}

/**
 * Keeps only the keys the destination's kind may carry, and collapses an empty payload to `null`.
 *
 * `destinationData` is a `strictObject` on the server, so a stray key is a 400 — and an object
 * with every field blank is not "no data", it is `{}`, which reads back as a payload that exists.
 */
function normalizeData(
	data: DestinationData | null | undefined,
	keep: "value" | "cause" | "args",
): DestinationData | null {
	if (!data) {
		return null;
	}
	const next: { value?: string; cause?: string; args?: DestinationData["args"] } = {};
	if (keep === "value" && data.value !== undefined && data.value.trim().length > 0) {
		next.value = data.value.trim();
	}
	if (keep === "cause" && data.cause !== undefined && data.cause.trim().length > 0) {
		next.cause = data.cause.trim();
	}
	if (data.args !== undefined && Object.keys(data.args).length > 0) {
		next.args = data.args;
	}
	return Object.keys(next).length > 0 ? next : null;
}

/**
 * Whether a trio is complete enough to send, and what to say when it is not.
 *
 * The server checks this too — in the same transaction as the write, which is the only place it
 * can be checked correctly — so this exists to keep the round trip out of the common case, not to
 * replace it.
 */
export function validateDestinationValue(
	value: DestinationValue,
	options: { readonly required: boolean },
): { readonly field: "type" | "ref" | "data"; readonly message: string } | undefined {
	if (value.type === null) {
		return options.required ? { field: "type", message: "A destination is required." } : undefined;
	}
	const kind = destinationKind(value.type);
	if (kind === "entity" && !value.ref) {
		return {
			field: "ref",
			message: `Choose which ${DESTINATION_TYPE_LABELS[value.type].toLowerCase()} the call goes to.`,
		};
	}
	if (kind === "value" && !value.data?.value?.trim()) {
		return {
			field: "data",
			message:
				value.type === "external"
					? "Enter the number to dial, in E.164 (e.g. +12125550100)."
					: "Enter the application name to run.",
		};
	}
	return undefined;
}

/** A one-line summary for a table cell. */
export function describeDestination(
	value: DestinationValue,
	nameOf?: (type: DestinationType, ref: string) => string | undefined,
): string {
	if (value.type === null) {
		return "—";
	}
	const label = DESTINATION_TYPE_LABELS[value.type];
	if (destinationKind(value.type) === "entity" && value.ref) {
		return `${label}: ${nameOf?.(value.type, value.ref) ?? value.ref.slice(0, 8)}`;
	}
	if (value.data?.value) {
		return `${label}: ${value.data.value}`;
	}
	return value.data?.cause ? `${label} (${value.data.cause})` : label;
}
