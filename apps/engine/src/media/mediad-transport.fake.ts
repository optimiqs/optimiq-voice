import { RPC_SUBJECTS } from "@optimiq-voice/events";
import { MediadTransportError } from "./mediad-transport";
import type { MediadTransport } from "./mediad-transport";

/**
 * An in-memory {@link MediadTransport} that records requests and replays canned replies.
 *
 * Test scaffolding, not product code: excluded from `tsconfig.build.json` by the `*.fake.ts`
 * pattern, exactly as `media-port.fake.ts` and `claim-store.fake.ts` are.
 *
 * ## What it is for, and what it deliberately does not do
 *
 * It records the EXACT payload each call put on the wire, because the framing is the thing this
 * seam exists to get right: the responder is a Go process reading the bare contract struct, and a
 * request wrapped in Nest's `{pattern, data}` frame would be refused as `bad_request` three layers
 * away from the serializer that caused it. A spec that asserts the recorded payload is the only
 * cheap way to pin that.
 *
 * It does NOT validate the request against the contract schema. That would make this fake agree
 * with the adapter by construction, and the whole point of asserting the payload is that a human
 * wrote down what the wire should look like.
 */
export interface RecordedMediadRequest {
	readonly subject: string;
	readonly payload: unknown;
	readonly timeoutMs: number;
}

export class FakeMediadTransport implements MediadTransport {
	/** Every request, in order. */
	readonly requests: RecordedMediadRequest[] = [];

	/** Replies keyed by subject. A subject with no entry gets {@link defaultReply}. */
	private readonly replies = new Map<string, unknown>();

	/** When set, every request throws it — a broker that is gone, or a `mediad` that is not there. */
	failure: Error | undefined;

	isConnected = true;

	/** Queues the reply the next request on `subject` receives. */
	reply(subject: string, value: unknown): this {
		this.replies.set(subject, value);
		return this;
	}

	/** The reply used when a subject has no queued one: a bare success. */
	private defaultReply(subject: string, payload: unknown): unknown {
		const request = payload as Record<string, unknown>;
		switch (subject) {
			case RPC_SUBJECTS.mediaAllocateSession:
				return {
					ok: true,
					sessionId: request["sessionId"],
					sdpAnswer: "v=0\r\no=- 30000 1 IN IP4 203.0.113.10\r\n",
					instanceId: "mediad-fake",
					address: "203.0.113.10",
					rtpPort: 30_000,
					rtcpPort: 30_001,
					ssrc: 4_277_009_102,
					codec: "PCMU",
					telephoneEventPayloadType: 101,
				};
			case RPC_SUBJECTS.mediaBridgeSessions:
				return {
					ok: true,
					bridgeId: request["bridgeId"],
					sessionIds: request["sessionIds"] ?? [],
					instanceId: "mediad-fake",
				};
			case RPC_SUBJECTS.mediaUnbridgeSessions:
				return {
					ok: true,
					bridgeId: request["bridgeId"],
					unbridged: true,
					sessionIds: [],
					instanceId: "mediad-fake",
				};
			case RPC_SUBJECTS.mediaStartPlayback:
				return {
					ok: true,
					sessionId: request["sessionId"],
					playbackRef: request["playbackRef"],
					instanceId: "mediad-fake",
				};
			case RPC_SUBJECTS.mediaStopPlayback:
				return {
					ok: true,
					playbackRef: request["playbackRef"],
					stopped: true,
					sessionId: "leg-a",
					instanceId: "mediad-fake",
				};
			case RPC_SUBJECTS.mediaSendDtmf:
				return {
					ok: true,
					sessionId: request["sessionId"],
					digits: request["digits"],
					queuedMs: 200,
					telephoneEventPayloadType: 101,
					instanceId: "mediad-fake",
				};
			case RPC_SUBJECTS.mediaStartRecording:
				return {
					ok: true,
					sessionId: request["sessionId"],
					recordingRef: request["recordingRef"],
					objectKey: `org/call/${String(request["recordingRef"])}.wav`,
					instanceId: "mediad-fake",
				};
			case RPC_SUBJECTS.mediaStopRecording:
				return {
					ok: true,
					recordingRef: request["recordingRef"],
					stopped: true,
					sessionId: "leg-a",
					instanceId: "mediad-fake",
				};
			case RPC_SUBJECTS.mediaReleaseSession:
				return {
					ok: true,
					sessionId: request["sessionId"],
					released: true,
					instanceId: "mediad-fake",
				};
			default:
				return { ok: true };
		}
	}

	async request(subject: string, payload: unknown, timeoutMs: number): Promise<unknown> {
		this.requests.push({ subject, payload, timeoutMs });
		await Promise.resolve();
		if (this.failure !== undefined) {
			throw this.failure;
		}
		const queued = this.replies.get(subject);
		return queued ?? this.defaultReply(subject, payload);
	}

	/** Every request issued on one subject. */
	on(subject: string): RecordedMediadRequest[] {
		return this.requests.filter((request) => request.subject === subject);
	}

	/** A transport whose broker is unreachable, for the boot-refusal path. */
	static unreachable(subject = RPC_SUBJECTS.mediaReleaseSession): FakeMediadTransport {
		const transport = new FakeMediadTransport();
		transport.failure = new MediadTransportError(subject, "no reply within 500ms");
		transport.isConnected = false;
		return transport;
	}
}
