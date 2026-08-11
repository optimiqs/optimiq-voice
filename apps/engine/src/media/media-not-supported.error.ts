/**
 * Thrown when a {@link import("./media-port").MediaPort} operation is real but the selected media
 * plane cannot do it yet.
 *
 * ## Why this is an exception and never a no-op
 *
 * The cutover in `plans/mediad-design.md` §2 is per CAPABILITY: `mediad` climbs a ladder and
 * Asterisk keeps serving every rung above the one it has reached. A media plane that quietly
 * accepted `record` and did nothing would produce a call that connects, sounds perfect, and has no
 * recording — discovered days later by somebody who needed it, with nothing in any log to say why.
 * The same silence on `startMusicOnHold` is a held caller listening to nothing and hanging up.
 *
 * Those are the worst defects a telephony system can have, because they are invisible at the moment
 * they happen. So an unimplemented rung fails LOUDLY, names the capability, and names the rung it
 * arrives on — which turns "the media plane is broken" into "this deployment asked mediad for
 * recording, which is rung 4".
 *
 * ## Why it carries structured fields
 *
 * `operation` and `capability` are read, not just logged: a caller that wants to fall back to
 * Asterisk for one operation needs to branch on WHICH operation was refused, and branching on a
 * message string is how a refactor becomes an outage.
 */
export class MediaOperationNotSupportedError extends Error {
	/** The `MediaPort` method that was called, e.g. `record`. */
	readonly operation: string;
	/** The capability it needs, in the ladder's own vocabulary, e.g. `recording (rung 4)`. */
	readonly capability: string;
	/** Which media driver refused. Always `mediad` today; named so a log line is unambiguous. */
	readonly driver: string;

	constructor(operation: string, capability: string, driver = "mediad") {
		super(
			`${driver} cannot ${operation}: it needs ${capability}, which this media plane does not ` +
				"implement yet. Set ENGINE_MEDIA_DRIVER=ari to serve this call with Asterisk, or see " +
				"plans/mediad-design.md §2 for the capability ladder.",
		);
		this.name = "MediaOperationNotSupportedError";
		this.operation = operation;
		this.capability = capability;
		this.driver = driver;
	}
}

/** Thrown when `mediad` refuses a command it does understand. `reason` is the contract's code. */
export class MediaCommandRefusedError extends Error {
	/** The machine-readable refusal code. Branch on THIS, never on the message. */
	readonly reason: string;
	readonly subject: string;
	/** The `mediad` instance that refused, when it named itself. */
	readonly instanceId: string | undefined;

	constructor(subject: string, reason: string, detail: string, instanceId?: string) {
		super(`mediad refused ${subject} (${reason}): ${detail}`);
		this.name = "MediaCommandRefusedError";
		this.reason = reason;
		this.subject = subject;
		this.instanceId = instanceId;
	}
}
