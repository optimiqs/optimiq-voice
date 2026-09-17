import { z } from "zod";
import { subjectFor, type TrunkEvent } from "../subjects";
import { defineEvent, makeEvent, type EventInput } from "./envelope";

/**
 * Trunk events — `trunk.evt.v1.<orgId>.<trunkId>.status.changed`.
 *
 * The write-back half of the qualify loop. The media server pings every carrier trunk on a timer
 * (`qualify_frequency` in the PJSIP config), the engine translates the transition it reports into
 * this event, and the control plane's durable consumer lands it in the `trunk.status*` columns —
 * which is the ONLY thing that writes those columns. The trunk id is subject-carried and therefore
 * absent from the payload, on the same rule as `queueId` and `mailboxId`: one copy, in the address.
 *
 * ## One event, not a state snapshot
 *
 * `status.changed` is a transition, published when the answer CHANGES rather than on every qualify
 * tick — see the vocabulary note in `subjects.ts`. That is what makes it safe for the consumer to
 * write a row per event: the write rate is the rate at which carriers actually go up and down, not
 * the qualify frequency times the trunk count.
 */

/**
 * The persisted trunk-status vocabulary.
 *
 * **MUST equal `TRUNK_STATUSES` in `packages/pbx-db/src/schema/trunks-schema.ts`, member for
 * member and in the same order.** The contract package cannot import the database package — the Go
 * side consumes this schema and holds no Drizzle — so the list is restated here and the comment is
 * the tie. The event exists to be written into `trunk.status`, and a value that column cannot hold
 * is an event the consumer can only drop.
 *
 * The producer never emits `disabled`: disabling a trunk is a control-plane decision recorded by
 * the API when the row is updated, not a fact a qualify can observe. It is in the vocabulary
 * because the vocabulary is the COLUMN's, and a consumer that re-publishes a row's current status
 * (a resync) must be able to say what the row says.
 */
export const TRUNK_STATUS_VALUES = ["unknown", "up", "down", "degraded", "disabled"] as const;

export const trunkStatusSchema = z.enum(TRUNK_STATUS_VALUES);
export type TrunkStatusValue = z.infer<typeof trunkStatusSchema>;

/** `status.changed` — the media server's verdict on a trunk's reachability moved. */
export const trunkStatusChangedDataSchema = z.object({
	status: trunkStatusSchema,
	/**
	 * What the media server said, verbatim (`Reachable`, `Unreachable`, …). Kept because the
	 * five-member `status` is a projection: when a future media server invents a new word, this is
	 * the only evidence of what it actually reported. Lands in `trunk.status_reason`.
	 */
	reason: z.string().min(1).max(256).optional(),
	/** Qualify round-trip time in milliseconds, when the media server measured one. */
	latencyMs: z.int().min(0).max(3_600_000).optional(),
	/**
	 * The PJSIP endpoint name the qualify ran against — the trunk's NAME, which is what the media
	 * server addresses. Carried so a replayed event is debuggable without the `trunk` row: the
	 * subject has the id, and the id alone answers "which row" but not "which carrier".
	 */
	endpoint: z.string().min(1).max(256).optional(),
});

export const TRUNK_EVENT_DEFINITIONS = {
	"status.changed": defineEvent("trunk", "status.changed", trunkStatusChangedDataSchema),
} as const;

export type TrunkEventDefinitions = typeof TRUNK_EVENT_DEFINITIONS;

export type TrunkEventOf<TType extends TrunkEvent> = z.infer<
	TrunkEventDefinitions[TType]["envelope"]
>;

export type TrunkEventDataOf<TType extends TrunkEvent> = z.infer<
	TrunkEventDefinitions[TType]["data"]
>;

export type TrunkStatusChangedData = z.infer<typeof trunkStatusChangedDataSchema>;

/**
 * Every trunk event as one union.
 *
 * A single-member union today, shaped like `voicemailEventSchema` on purpose: consumers
 * (`live-hub`, the durable writer) parse against the FAMILY schema, so a second event joins the
 * family without touching them.
 */
export const trunkEventSchema = z.discriminatedUnion("type", [
	TRUNK_EVENT_DEFINITIONS["status.changed"].envelope,
]);

export type TrunkEventEnvelope = z.infer<typeof trunkEventSchema>;

export interface TrunkEventInput<TType extends TrunkEvent> extends Omit<
	EventInput<TrunkEventDataOf<TType>>,
	"subject"
> {
	/** The `trunk` row id. */
	readonly trunkId: string;
}

/** Builds and validates a trunk event, deriving `trunk.evt.v1.<orgId>.<trunkId>.<type>`. */
export function makeTrunkEvent<TType extends TrunkEvent>(
	type: TType,
	input: TrunkEventInput<TType>,
): TrunkEventOf<TType> {
	const definition = TRUNK_EVENT_DEFINITIONS[type];
	const subject = subjectFor.trunk(input.orgId, input.trunkId, type);
	// See the note in `makeCallEvent`: the record index and the payload are correlated by `type`.
	return makeEvent(definition, { ...input, subject } as never) as TrunkEventOf<TType>;
}
