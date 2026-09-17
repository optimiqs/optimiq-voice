import { Inject, Injectable } from "@nestjs/common";
import { firstValueFrom, timeout } from "rxjs";
import { FILE_GREETING_RPC, fileGreetingResponseSchema } from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { ROUTING_RPC_CLIENT } from "../nats/nats.tokens";
import type { RecordedGreeting, VoicemailGreetingPort } from "./plan-walker";
import type { ClientProxy } from "@nestjs/microservices";
import type { FileGreetingRequest } from "@optimiq-voice/events";

/**
 * `*99` — the greeting a user has just recorded, filed over `rpc.pbx.v1.file-greeting`.
 *
 * ## Why this could not be an event, and why the walk waited for it
 *
 * The engine already publishes `voicemail.message.left` when it records into a mailbox, so filing a
 * greeting by publishing looked like the short path and is the wrong one: that event inserts a
 * `voicemail_message` row, archives the audio and lights the MWI lamp, which would put somebody's
 * own greeting in their own inbox while the mailbox went on playing the deployment's default
 * announcement. A greeting is what a mailbox SAYS, not something it received.
 *
 * Filing one is a two-row write — clear the incumbent active greeting of that kind, insert the new
 * one — inside a recompile, because `voicemail_greeting` is a routing input the compiler embeds
 * into the mailbox's `leave` node. `voicemail-greetings.service.ts` sets out why those statements
 * cannot be split. The engine holds no database handle and must not grow one, so the press has to
 * become a request; and it has to be request-REPLY rather than a publish because `*99`'s whole
 * design rests on knowing the answer: the port is checked before the beep, and the confirmation is
 * played only once the greeting is filed.
 *
 * ## The audio is a KEY
 *
 * The engine never holds the bytes — the media server writes the recording onto the mount every
 * process shares, and the engine learns a name for it — so the request carries `objectKey` and the
 * responder ingests the file. The contract's own note has the full reasoning, including why a
 * payload of audio would be a broker-sized problem rather than a design preference.
 *
 * ## The deadline comes from the contract, not from the environment
 *
 * Like `ExtensionFeatureRpcPort` and unlike the mailbox source: the five seconds cover a copy and a
 * whole-tenant recompile inside the write's transaction, so a deployment that shortened the budget
 * would be one where every `*99` on a large tenant announces failure for a greeting that then
 * lands anyway. A knob whose only correct value is the contract's is a knob that can only be set
 * wrong.
 *
 * ## A refusal is a THROW here, and that is the port's contract rather than an inconsistency
 *
 * The other two feature ports answer with a refusal shape because the walk has something to say
 * about the state that came back. {@link VoicemailGreetingPort.greetingRecorded} returns `void` and
 * throws — "the walk announces rather than confirming" — so a refusal, a malformed reply and a
 * broker that never answered all become the same thing at this seam: an error carrying the reason,
 * which the walk turns into the "not available" announcement and a note naming the object the audio
 * is still sitting in. That note is the whole point of the reason surviving: the recording exists,
 * and an operator who knows its key can file it by hand.
 */
@Injectable()
export class VoicemailGreetingRpcPort implements VoicemailGreetingPort {
	private readonly logger = getLogger("engine.features");
	private calls = 0;
	private failures = 0;

	constructor(@Inject(ROUTING_RPC_CLIENT) private readonly client: ClientProxy) {}

	/** Call counters, on the same terms as the other feature ports': read by the specs, and available
	 * to a health surface that wants to see whether the responder is answering at all. */
	get stats(): { readonly calls: number; readonly failures: number } {
		return { calls: this.calls, failures: this.failures };
	}

	async greetingRecorded(greeting: RecordedGreeting): Promise<void> {
		this.calls += 1;
		const payload: FileGreetingRequest = {
			orgId: greeting.organizationId,
			voicemailBoxId: greeting.voicemailBoxId,
			mailboxNumber: greeting.mailboxNumber,
			greetingId: greeting.greetingId,
			kind: greeting.kind,
			objectKey: greeting.objectKey,
			recordingId: greeting.recordingId,
			durationMs: greeting.durationMs,
			...(greeting.callId === undefined ? {} : { callId: greeting.callId }),
		};

		let applied: { readonly applied: boolean; readonly reason?: string };
		try {
			// Parsed, not trusted: a responder on a shared broker is another process on another release,
			// and a malformed reply must become the announcement rather than a confirmation played for
			// a field that was not there.
			applied = fileGreetingResponseSchema.parse(
				await firstValueFrom(
					this.client
						.send(FILE_GREETING_RPC.subject, payload)
						.pipe(timeout(FILE_GREETING_RPC.timeoutMs)),
				),
			);
		} catch (error) {
			this.failures += 1;
			this.logger.warn(
				{
					organizationId: greeting.organizationId,
					mailboxNumber: greeting.mailboxNumber,
					objectKey: greeting.objectKey,
					err: String(error),
				},
				"rpc.pbx.v1.file-greeting did not answer; the greeting was recorded and not filed",
			);
			throw new Error("the greeting service did not answer");
		}

		if (!applied.applied) {
			this.failures += 1;
			this.logger.warn(
				{
					organizationId: greeting.organizationId,
					mailboxNumber: greeting.mailboxNumber,
					objectKey: greeting.objectKey,
					reason: applied.reason,
				},
				"rpc.pbx.v1.file-greeting refused the greeting",
			);
			// The responder's reason, not this port's: it is the only description of WHY that will ever
			// exist, and the walk writes it into the notes beside the object key.
			throw new Error(applied.reason ?? "the greeting service refused it");
		}
	}
}
