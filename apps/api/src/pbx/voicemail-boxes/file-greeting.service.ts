import { Inject, Injectable } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { eq, voicemailBox } from "@optimiq-voice/pbx-db";
import { AUDIO_PROBE_BYTES, probeAudio } from "../media/media-audio";
import { PBX_DATABASE, PBX_ENV, PBX_VOICEMAIL_STORE } from "../shared/pbx.tokens";
import { VoicemailGreetingsService } from "./voicemail-greetings.service";
import type { ObjectStore } from "../../storage";
import type { PbxEnv } from "../shared/pbx-env";
import type { FileGreetingResponse, VoicemailGreetingKind } from "@optimiq-voice/events/schemas";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";
import type { Readable } from "node:stream";

const logger = getLogger("api.pbx");

/**
 * `*99` — the greeting somebody just recorded into their own mailbox, filed.
 *
 * ## What this service is, and what it deliberately is not
 *
 * It is the claim check, the ingest and the refusal vocabulary. It is NOT the write: the two-row
 * activation and the recompile belong to {@link VoicemailGreetingsService}, which the HTTP upload
 * already goes through, and this calls the same method rather than reproducing it. A greeting
 * recorded from a handset and a greeting uploaded from the admin UI must land in exactly the same
 * state, and the only way to be sure of that is for there to be one piece of code that lands them.
 *
 * ## The claim is resolved, never trusted
 *
 * `mailboxNumber` arrives from the engine, which knows it because the call came from the extension
 * that owns the box and because the box's PIN gate — the same one `*97` applies — was satisfied.
 * That is authentication of the strength of the phone on the desk, and it is not authorization: a
 * request on a shared broker proves only that something reached the broker. So the box is loaded
 * under `withTenantScope(orgId)` and its own `mailbox_number` must equal the claimed one; a
 * disabled box and an unknown one are refused identically, because telling them apart over a phone
 * line is a way to enumerate a tenant's mailboxes.
 *
 * ## The object key is the OTHER claim, and it is the sharper one
 *
 * Every other object key this area handles was built by this server out of UUIDs it minted
 * (`media-storage.ts` says why at length). This one arrives on the wire. Two things follow, and
 * both are enforced in {@link FileGreetingService.readRecording}:
 *
 * - **It must live under the requesting organization's own prefix.** The engine writes recordings
 *   as `<orgId>/<callId>/<recordingId>.<ext>`, so the tenant is the first segment and checking it
 *   costs a `split`. Without that check, a request naming another tenant's recording would file
 *   that tenant's audio as this tenant's greeting — a cross-tenant read with a playback route
 *   attached to it.
 * - **It must not try to leave the root.** `LocalObjectStore` throws `ObjectKeyOutsideRootError`
 *   for a key that resolves outside its directory, so the store is the backstop; the prefix check
 *   above is what makes the traversal attempt impossible to express in the first place.
 *
 * ## Nothing throws at the caller
 *
 * Every refusal is `applied: false` with a reason, and the engine turns that into the "not
 * available" announcement. A timeout would be much worse than a refusal here: the user has already
 * spent thirty seconds recording, and silence is what they would take for success. See
 * `FILE_GREETING_RPC` in `packages/events`.
 */
@Injectable()
export class FileGreetingService {
	constructor(
		@Inject(PBX_ENV) private readonly env: PbxEnv,
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		/**
		 * The store the RECORDING is in — the recordings root, which is where the media server wrote
		 * the file and which `voicemail-consumer.service.ts` reads a message's audio from.
		 *
		 * Deliberately not the media library's store, even though `pbx-env.ts` makes them the same
		 * directory in every shipped configuration: the two roots are separately nameable, and a
		 * deployment that split them would have the recording under one and the greeting under the
		 * other. Reading through the root the key was MINTED against is what stays correct either way,
		 * and it is why the ingest is a copy rather than a rename.
		 */
		@Inject(PBX_VOICEMAIL_STORE) private readonly recordings: ObjectStore,
		@Inject(VoicemailGreetingsService) private readonly greetings: VoicemailGreetingsService,
	) {}

	/**
	 * Files one recorded greeting and answers with what the mailbox now says.
	 *
	 * @throws never. Somebody is listening to silence while this runs.
	 */
	async fileForBroker(request: {
		readonly orgId: string;
		readonly voicemailBoxId: string;
		readonly mailboxNumber: string;
		readonly greetingId: string;
		readonly kind: VoicemailGreetingKind;
		readonly objectKey: string;
		readonly durationMs: number;
		readonly recordingId?: string;
		readonly callId?: string;
	}): Promise<FileGreetingResponse> {
		const box = await this.resolveClaim(request.orgId, request.voicemailBoxId);
		if (box === undefined || box.mailboxNumber !== request.mailboxNumber) {
			// One refusal for "no such box", "the box is disabled" and "that box is not that number",
			// because all three are the same fact to the person holding the handset and the differences
			// between them are exactly what an enumeration would be built out of.
			return refuse(
				request.kind,
				`no enabled mailbox ${request.mailboxNumber} in this organization`,
			);
		}

		const audio = await this.readRecording(request.orgId, request.objectKey);
		if (audio.kind === "refused") {
			logger.warn(
				{
					orgId: request.orgId,
					voicemailBoxId: request.voicemailBoxId,
					objectKey: request.objectKey,
					recordingId: request.recordingId,
					reason: audio.reason,
				},
				"rpc.pbx.v1.file-greeting could not read the recording it was sent",
			);
			return refuse(request.kind, audio.reason);
		}

		try {
			const filed = await this.greetings.fileRecordedGreeting({
				organizationId: request.orgId,
				boxId: request.voicemailBoxId,
				greetingId: request.greetingId,
				kind: request.kind,
				label: `${request.kind} greeting recorded from ${request.mailboxNumber}`,
				durationMs: request.durationMs,
				audio: audio.audio,
			});
			return {
				applied: true,
				kind: request.kind,
				// Always true on this path: `*99` exists to change what a mailbox says, so
				// `fileRecordedGreeting` activates unconditionally. Reported rather than assumed,
				// because the engine branches on it and the day an inactive variant exists this field
				// is what will already be carrying the difference.
				active: true,
				greetingId: request.greetingId,
				objectKey: filed.objectKey,
			};
		} catch (error) {
			// Includes the 422 an unsound recompile produces: the transaction has already rolled the
			// row back and the object has already been unlinked, so the mailbox still says what it said
			// this morning. The caller hears "not available" rather than a confirmation for a greeting
			// that did not survive.
			logger.error(
				{
					orgId: request.orgId,
					voicemailBoxId: request.voicemailBoxId,
					greetingId: request.greetingId,
					callId: request.callId,
					error,
				},
				"rpc.pbx.v1.file-greeting could not file the greeting",
			);
			return refuse(
				request.kind,
				`the greeting could not be filed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * The mailbox behind the claimed id, or `undefined`.
	 *
	 * `enabled` is part of the question rather than a field to check afterwards, for the reason
	 * `extension-feature.service.ts` gives about a disabled extension: a disabled box is not a box
	 * any caller can reach, so replacing its greeting would recompile a tenant for audio nothing
	 * plays. RLS is the tenant filter — there is no `organization_id` predicate here, as everywhere
	 * else in this area.
	 */
	private async resolveClaim(
		organizationId: string,
		voicemailBoxId: string,
	): Promise<{ readonly mailboxNumber: string } | undefined> {
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const rows = await transaction
				.select({
					mailboxNumber: voicemailBox.mailboxNumber,
					enabled: voicemailBox.enabled,
				})
				.from(voicemailBox)
				.where(eq(voicemailBox.id, voicemailBoxId))
				.limit(1);
			const row = rows[0];
			return row === undefined || !row.enabled ? undefined : { mailboxNumber: row.mailboxNumber };
		});
	}

	/**
	 * Reads the recorded audio the request named, and proves it is audio.
	 *
	 * The tenant-prefix check is here rather than at the controller because it is a property of the
	 * READ: this is the one method in the area that opens an object under a key it did not build, and
	 * a check that lives anywhere else is a check a second caller can skip. See the header.
	 *
	 * The bytes are then run through `probeAudio` — the SAME sniffer the multipart upload uses, and
	 * for the same reason it uses it: a `.wav` extension is a claim about a file's name, not about
	 * its contents, and a greeting that turns out not to be audio is silence a mailbox plays at
	 * every caller. On this path the sniffer is also the cheapest possible answer to "did the media
	 * server actually finish writing the file", which is the failure a `head` alone would miss.
	 */
	private async readRecording(
		organizationId: string,
		objectKey: string,
	): Promise<
		| {
				readonly kind: "read";
				readonly audio: {
					readonly bytes: Buffer;
					readonly contentType: string;
					readonly extension: string;
				};
		  }
		| { readonly kind: "refused"; readonly reason: string }
	> {
		if (!objectKey.startsWith(`${organizationId}/`)) {
			// Not "not found": this is a request that named somebody else's audio, or tried to walk out
			// of the recordings root, and it is worth being able to find that in a log by its own words.
			return {
				kind: "refused",
				reason: "the recording does not belong to this organization",
			};
		}

		let stat: Awaited<ReturnType<ObjectStore["head"]>>;
		try {
			stat = await this.recordings.head(objectKey);
		} catch (error) {
			// `ObjectKeyOutsideRootError`, which the prefix check above should already have made
			// impossible. Caught rather than allowed to propagate because the responder answers
			// everything, including a defect in its own guard.
			return {
				kind: "refused",
				reason: `the recording could not be opened: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		if (stat === undefined) {
			return { kind: "refused", reason: "there is no recording under that key" };
		}
		if (stat.sizeBytes === 0) {
			return { kind: "refused", reason: "the recording is empty" };
		}
		if (stat.sizeBytes > this.env.PBX_MEDIA_MAX_UPLOAD_BYTES) {
			// The upload cap, applied to the broker path as well. A greeting is bounded by the walker's
			// `greetingMaxSeconds` long before it reaches this, so a file over the cap is a key naming
			// something that is not a greeting — an hour of call recording, most likely.
			return {
				kind: "refused",
				reason: `the recording is larger than this deployment stores (${String(stat.sizeBytes)} bytes)`,
			};
		}

		let bytes: Buffer;
		try {
			bytes = await readAll(await this.recordings.getStream(objectKey));
		} catch (error) {
			return {
				kind: "refused",
				reason: `the recording could not be read: ${error instanceof Error ? error.message : String(error)}`,
			};
		}

		const probe = probeAudio(bytes.subarray(0, AUDIO_PROBE_BYTES));
		if (probe.format === undefined) {
			return {
				kind: "refused",
				reason: probe.issue ?? "the recording is not audio this library stores",
			};
		}
		return {
			kind: "read",
			audio: {
				bytes,
				contentType: probe.format.contentType,
				extension: probe.format.extension,
			},
		};
	}
}

/** Every refusal carries `applied: false` AND `active: false`: the mailbox still says what it said. */
function refuse(kind: VoicemailGreetingKind, reason: string): FileGreetingResponse {
	return { applied: false, kind, active: false, reason: reason.slice(0, 256) };
}

/**
 * Buffers a stream.
 *
 * Bounded by the caller — the size is checked against `PBX_MEDIA_MAX_UPLOAD_BYTES` before this runs
 * — and buffered rather than piped because the destination is `ObjectStore.put`, which takes bytes.
 * A greeting is a minute of 8 kHz audio at the outside, which is the same order as the multipart
 * upload this path joins.
 */
async function readAll(stream: Readable): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferView["buffer"]));
	}
	return Buffer.concat(chunks);
}
