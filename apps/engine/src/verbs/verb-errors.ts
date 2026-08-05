import { BadRequestException, ConflictException, NotImplementedException } from "@nestjs/common";
import * as Schema from "effect/Schema";
import type { HttpException } from "@nestjs/common";

/**
 * Verb-execution failures.
 *
 * `Schema.TaggedErrorClass` per the oikos convention (§3): each failure is an Effect error with a
 * `_tag`, and each knows its own HTTP representation via `toHttpException()` so the `runEffect`
 * seam can map it without a translation table. The engine's own event path does not go through
 * HTTP, but the session-protocol server that lands in P3 does, and a failure type that cannot
 * cross that seam would have to be re-declared there.
 *
 * Naming follows the convention: `…Failure` inside an app's Effect code.
 */

/**
 * A verb was sent that the engine does not implement yet.
 *
 * A first-class failure rather than a `default:` branch, because the P2 slice implements 5 of the
 * 28 verbs and an application that sends `dial` deserves to be told "not yet", not to have its
 * call silently do nothing.
 */
export class UnsupportedVerbFailure extends Schema.TaggedErrorClass<UnsupportedVerbFailure>()(
	"UnsupportedVerbFailure",
	{
		verb: Schema.String,
		channelId: Schema.String,
	},
) {
	toHttpException(): HttpException {
		return new NotImplementedException(`Verb "${this.verb}" is not implemented yet.`);
	}
}

/**
 * The verb was refused because the leg is in a state that forbids it.
 *
 * The guard half of guard-then-execute: playing audio at a leg that has neither answered nor
 * opened early media, or sending any verb to a leg that is tearing down. Both are protocol errors
 * the engine must refuse rather than paper over — implicitly answering a call to satisfy a `play`
 * starts billing a caller for a call they never got.
 */
export class VerbNotPermittedFailure extends Schema.TaggedErrorClass<VerbNotPermittedFailure>()(
	"VerbNotPermittedFailure",
	{
		verb: Schema.String,
		channelId: Schema.String,
		reason: Schema.String,
	},
) {
	toHttpException(): HttpException {
		return new ConflictException(`Verb "${this.verb}" is not permitted: ${this.reason}`);
	}
}

/** A verb arrived for a channel the engine is not tracking. */
export class UnknownChannelFailure extends Schema.TaggedErrorClass<UnknownChannelFailure>()(
	"UnknownChannelFailure",
	{
		channelId: Schema.String,
	},
) {
	toHttpException(): HttpException {
		return new BadRequestException(`Channel "${this.channelId}" is not known to this engine.`);
	}
}

/**
 * The media server refused or failed the command.
 *
 * Distinct from the two above so that the retry decision is possible: those are OUR errors and
 * will fail identically forever; this one may be a media server that is briefly unwell.
 */
export class MediaCommandFailure extends Schema.TaggedErrorClass<MediaCommandFailure>()(
	"MediaCommandFailure",
	{
		verb: Schema.String,
		channelId: Schema.String,
		detail: Schema.String,
	},
) {
	toHttpException(): HttpException {
		return new ConflictException(`Media server refused "${this.verb}": ${this.detail}`);
	}
}

/** Every failure a verb execution can produce. */
export type VerbFailure =
	| UnsupportedVerbFailure
	| VerbNotPermittedFailure
	| UnknownChannelFailure
	| MediaCommandFailure;
