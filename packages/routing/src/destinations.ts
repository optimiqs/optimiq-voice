/**
 * The polymorphic destination trio, as the compiler sees it.
 *
 * This mirrors `packages/pbx-db/src/destinations.ts` — the same eleven types, the same
 * entity/value/terminal kinds, the same shape rules. It is a *mirror* and not an import for the
 * reason set out at the top of `snapshot.ts`: the compiler must not depend on a database package.
 * `destinations.spec.ts` pins the vocabulary so the two copies cannot silently diverge, and the
 * API's snapshot loader (which depends on both) is where a real drift would show up first.
 *
 * The database check constraint only enforces the *shape* of a trio — it cannot know whether a
 * `destination_ref` resolves. That is exactly what the compiler's validation pass is for, and it
 * is why a dangling reference is a compile error rather than a runtime surprise on a live call.
 */

/** Every destination a compiled route may point at. Mirrors `pbx-db` `DESTINATION_TYPES`. */
export const DESTINATION_TYPES = [
	"extension",
	"ivr",
	"ring-group",
	"queue",
	"voicemail",
	"conference",
	"park",
	"paging-group",
	"time-condition",
	"external",
	"application",
	"hangup",
] as const;

export type DestinationType = (typeof DESTINATION_TYPES)[number];

/**
 * - `entity`: the target is a row in the tenant's configuration; `ref` is required.
 * - `value`: the target is a literal (an E.164 number, an engine application name); `data.value`
 *   is required and `ref` must be absent.
 * - `terminal`: the call ends here; neither is required.
 */
export type DestinationKind = "entity" | "value" | "terminal";

export const DESTINATION_TYPE_KINDS: Readonly<Record<DestinationType, DestinationKind>> = {
	extension: "entity",
	ivr: "entity",
	"ring-group": "entity",
	queue: "entity",
	voicemail: "entity",
	conference: "entity",
	park: "entity",
	"paging-group": "entity",
	"time-condition": "entity",
	external: "value",
	application: "value",
	hangup: "terminal",
} as const;

/**
 * Which snapshot collection an entity-backed destination resolves against. This is the compiler's
 * half of `pbx-db`'s `DESTINATION_TARGET_TABLES`: same relationships, expressed in terms of the
 * snapshot rather than of physical tables.
 */
export const DESTINATION_TARGET_COLLECTIONS: Readonly<Record<DestinationType, string | null>> = {
	extension: "extensions",
	ivr: "ivrMenus",
	"ring-group": "ringGroups",
	queue: "queues",
	voicemail: "voicemailBoxes",
	conference: "conferences",
	park: "parkLots",
	"paging-group": "pagingGroups",
	"time-condition": "timeConditions",
	external: null,
	application: null,
	hangup: null,
} as const;

/** Payload stored in `<p>destination_data`. Mirrors `pbx-db` `DestinationData`. */
export interface DestinationData {
	/** E.164 number for `external`; engine application name for `application`. */
	readonly value?: string;
	readonly args?: Readonly<Record<string, string | number | boolean>>;
	/** Q.850 / FreeSWITCH-extended cause name for `hangup`. */
	readonly cause?: string;
}

/** A destination as it arrives from the database, before the compiler interprets it. */
export interface Destination {
	readonly destinationType: DestinationType;
	readonly destinationRef?: string | null;
	readonly destinationData?: DestinationData | null;
}

/** The three columns a snapshot row contributes for its primary destination. */
export interface DestinationInput {
	readonly destinationType: DestinationType;
	readonly destinationRef?: string | null;
	readonly destinationData?: DestinationData | null;
}

const DESTINATION_TYPE_SET: ReadonlySet<string> = new Set(DESTINATION_TYPES);

export function isDestinationType(value: unknown): value is DestinationType {
	return typeof value === "string" && DESTINATION_TYPE_SET.has(value);
}

export function destinationKind(type: DestinationType): DestinationKind {
	return DESTINATION_TYPE_KINDS[type];
}

export function destinationTargetCollection(type: DestinationType): string | null {
	return DESTINATION_TARGET_COLLECTIONS[type];
}

/** Whether a destination type resolves against a snapshot collection. */
export function isEntityDestination(type: DestinationType): boolean {
	return DESTINATION_TYPE_KINDS[type] === "entity";
}

export type DestinationShapeIssue =
	| "unknown-type"
	| "missing-ref"
	| "unexpected-ref"
	| "missing-value";

/**
 * Shape-checks one destination. Mirrors `pbx-db`'s `validateDestination` minus the UUID format
 * check, which belongs to the CRUD layer: by the time a row reaches the compiler it has already
 * passed the database's own constraint, so re-litigating id formatting here would only produce
 * duplicate errors on a form.
 */
export function destinationShapeIssues(destination: Destination): readonly DestinationShapeIssue[] {
	if (!isDestinationType(destination.destinationType)) {
		return ["unknown-type"];
	}
	const issues: DestinationShapeIssue[] = [];
	const ref = destination.destinationRef ?? null;
	const data = destination.destinationData ?? null;

	switch (destinationKind(destination.destinationType)) {
		case "entity": {
			if (ref === null || ref.length === 0) {
				issues.push("missing-ref");
			}
			break;
		}
		case "value": {
			if (ref !== null) {
				issues.push("unexpected-ref");
			}
			if (data === null || data.value === undefined || data.value.trim().length === 0) {
				issues.push("missing-value");
			}
			break;
		}
		default: {
			if (ref !== null) {
				issues.push("unexpected-ref");
			}
			break;
		}
	}
	return issues;
}

/**
 * Reads an optional, prefixed destination trio (`timeoutDestinationType`, `failoverDestinationRef`,
 * …) off a row. Returns `null` when the trio is unset, which is how the schema spells "no
 * destination configured".
 */
export function readNamedDestination(
	row: Readonly<Record<string, unknown>>,
	prefix: string,
): Destination | null {
	const type = row[`${prefix}DestinationType`];
	if (type === undefined || type === null) {
		return null;
	}
	if (!isDestinationType(type)) {
		// Preserved verbatim so the validation pass can report `unknown-destination-type` with the
		// value the tenant actually stored, rather than swallowing it here.
		return { destinationType: type as DestinationType, destinationRef: null };
	}
	const ref = row[`${prefix}DestinationRef`];
	const data = row[`${prefix}DestinationData`];
	return {
		destinationType: type,
		destinationRef: typeof ref === "string" ? ref : null,
		destinationData: (data ?? null) as DestinationData | null,
	};
}

/** Reads a row's primary destination trio. */
export function readDestination(row: Readonly<Record<string, unknown>>): Destination {
	const type = row.destinationType;
	const ref = row.destinationRef;
	const data = row.destinationData;
	return {
		destinationType: type as DestinationType,
		destinationRef: typeof ref === "string" ? ref : null,
		destinationData: (data ?? null) as DestinationData | null,
	};
}

/**
 * A stable key for a destination, used to deduplicate compiled plan nodes.
 *
 * Two rows pointing at the same extension must compile to the same node, or the artifact grows a
 * node per reference and the "every reference resolves" property becomes meaningless. Value and
 * terminal destinations fold their payload into the key for the same reason.
 */
export function destinationKey(destination: Destination): string {
	const type = destination.destinationType;
	switch (isDestinationType(type) ? destinationKind(type) : "terminal") {
		case "entity": {
			return `${type}:${destination.destinationRef ?? ""}`;
		}
		case "value": {
			const value = destination.destinationData?.value ?? "";
			const args = destination.destinationData?.args;
			const argsKey =
				args === undefined
					? ""
					: `|${Object.keys(args)
							.sort()
							.map((key) => `${key}=${String(args[key])}`)
							.join(",")}`;
			return `${type}:${value}${argsKey}`;
		}
		default: {
			return `${type}:${destination.destinationData?.cause ?? ""}`;
		}
	}
}
