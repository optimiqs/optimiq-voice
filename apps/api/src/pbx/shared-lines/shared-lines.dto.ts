import { z } from "zod/v4";
import { SHARED_LINE_STRATEGIES } from "@optimiq-voice/pbx-db";
import { displayName, internalNumber, patchOf, resettable } from "../shared/dto";

/**
 * A shared line.
 *
 * `extensionNumber` is `.nullish()` for the reason a ring group's and a paging group's are: a line
 * that is only a shared KEY across a boss and an assistant has no dialable number of its own, and a
 * line with no number must not be forced to invent one that then collides with an extension. `null`
 * clears it — the column is genuinely nullable (partial-unique), so this is the "clear it" half of
 * {@link patchOf}'s contract, not the "reset to the server default" half.
 *
 * There is deliberately no destination trio here. A shared line never routes a call out: its whole
 * point is the state it keeps AFTER the answer, which lives in a KV claim the engine arbitrates, not
 * in a branch. See `shared-lines.resource.ts`.
 */
const sharedLineShape = {
	name: displayName,
	extensionNumber: internalNumber.nullish(),
	/**
	 * How the appearances are offered a call to the line's number. `simultaneous` lights and rings
	 * every appearance at once (the receptionist case); `sequential` walks them in ordinal order
	 * (boss-then-assistant). Optional because the column is `notNull().default('simultaneous')`.
	 */
	strategy: z.enum(SHARED_LINE_STRATEGIES).optional(),
	/**
	 * How long each appearance is rung before the offer moves on. `notNull().default(30)`, so it is
	 * `resettable`: a `null` puts it back to the server default rather than to NULL, which the column
	 * refuses. Bounds match a ring group's own ring timeout — five seconds is the floor a WAN handset
	 * needs, 600 the ceiling on how long a human is given to pick up.
	 */
	ringTimeoutSeconds: resettable(z.int().min(5).max(600)),
	/**
	 * How long a call held on the line may sit before it recalls — rings every appearance back so a
	 * held caller is not forgotten on a line whose holder walked away. `0` disables recall (the line
	 * holds indefinitely). `notNull().default(60)`, so `resettable` on the same terms as above; `0` is
	 * a real value the caller sends, and only `null` means "use the default".
	 */
	holdRecallTimeoutSeconds: resettable(z.int().min(0).max(3600)),
	/**
	 * Whether an idle appearance may join a call already up on the line (the boss/admin "barge"). Off
	 * by default because a line any appearance can silently join is a privacy surprise, not a default,
	 * so — like a paging group's `duplex` — this is optional and the safe value is the quiet one.
	 */
	bargeInEnabled: z.boolean().optional(),
	enabled: z.boolean().optional(),
};

export const createSharedLineDto = z.strictObject(sharedLineShape);

export const updateSharedLineDto = patchOf(z.strictObject(sharedLineShape));

/**
 * One appearance in the line.
 *
 * An `extensionId` and its appearance index, and nothing else. Like a paging member it may NOT carry
 * a destination trio: the engine originates a leg to a real registered endpoint and the credential
 * path tells that extension's device which button to light, so only a real extension can be an
 * appearance. The foreign key enforces that, and `on delete cascade` removes a deleted extension's
 * appearance in the same transaction rather than leaving a dark key an operator believes is live.
 */
const sharedLineAppearanceShape = {
	extensionId: z.uuid(),
	/** The appearance index: the phone's button position, rewritten wholesale by `PUT …/reorder`. */
	ordinal: z.int().min(0).max(1000),
	enabled: z.boolean().optional(),
};

export const createSharedLineAppearanceDto = z.strictObject(sharedLineAppearanceShape);

export const updateSharedLineAppearanceDto = patchOf(z.strictObject(sharedLineAppearanceShape));
