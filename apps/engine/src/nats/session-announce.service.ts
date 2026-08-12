import { Inject, Injectable } from "@nestjs/common";
import {
	SESSION_ANNOUNCE_RPC,
	sessionAnnounceResponseSchema,
	subjectFor,
} from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { JetStreamService } from "./jetstream.service";
import { ENGINE_ENV } from "./nats.tokens";
import type { EngineEnv } from "../config/engine-env";
import type { SessionAnnounceRequest, SessionAnnounceResponse } from "@optimiq-voice/events";

/**
 * Offers a call that has reached an `application` destination to whoever holds that application's
 * socket.
 *
 * ## The requester, not the responder — and the one refusal that is not a failure
 *
 * `no responders available` is the ANSWER, not an error. It means no control-plane replica is
 * subscribed to `rpc.session.v1.announce.<org>.<application>`, which means nobody has claimed that
 * application, which means the walker must run the destination's failure path. NATS reports it
 * synchronously and immediately — there is no timeout to wait out — and that immediacy is the whole
 * reason the registration was built as a subject subscription rather than as a directory somebody
 * has to read (see {@link RPC_SUBJECTS.sessionAnnounce}). A caller hears an announcement instead of
 * two seconds of silence followed by an announcement.
 *
 * So every outcome here is a {@link SessionAnnounceResponse}. Nothing throws, because there is no
 * failure mode on this path that the walker can do anything with other than announce.
 */
@Injectable()
export class SessionAnnounceService {
	private readonly logger = getLogger("engine.session");
	private readonly encoder = new TextEncoder();
	private readonly decoder = new TextDecoder();
	private announced = 0;
	private accepted = 0;

	constructor(
		@Inject(ENGINE_ENV) private readonly env: EngineEnv,
		private readonly jetstream: JetStreamService,
	) {}

	get stats(): { readonly announced: number; readonly accepted: number } {
		return { announced: this.announced, accepted: this.accepted };
	}

	/** Offers one call. Never throws; a broker problem is a refusal the walker can announce. */
	async announce(request: SessionAnnounceRequest): Promise<SessionAnnounceResponse> {
		this.announced += 1;
		const connection = this.jetstream.rawConnection;
		if (connection === undefined || connection.isClosed()) {
			return {
				accepted: false,
				reason: "no-application",
				error: "this engine has no broker connection",
			};
		}

		const subject = subjectFor.sessionAnnounceRpc(request.orgId, request.application);
		let raw: Uint8Array;
		try {
			const reply = await connection.request(
				subject,
				this.encoder.encode(JSON.stringify(request)),
				{ timeout: SESSION_ANNOUNCE_RPC.timeoutMs },
			);
			raw = reply.data;
		} catch (error) {
			// Two shapes arrive here and they mean the same thing to a caller on the line: nobody
			// answered. They are logged at different levels because they mean different things to an
			// operator — "this application was never connected" is a configuration fact, and "the
			// control plane did not answer in two seconds" is an incident.
			const detail = String(error);
			const noResponders = detail.includes("no responders");
			this.logger[noResponders ? "info" : "warn"](
				{ subject, application: request.application, orgId: request.orgId, err: detail },
				noResponders
					? "no application is registered for this destination"
					: "the control plane did not answer a session announcement",
			);
			return { accepted: false, reason: "no-application", error: detail.slice(0, 512) };
		}

		const parsed = sessionAnnounceResponseSchema.safeParse(
			JSON.parse(this.decoder.decode(raw)) as unknown,
		);
		if (!parsed.success) {
			this.logger.warn(
				{ subject, issues: parsed.error.issues.slice(0, 3).map((issue) => issue.message) },
				"a session announcement was answered with something that is not the contract",
			);
			return {
				accepted: false,
				reason: "internal",
				error: "the answer did not match the contract",
			};
		}
		if (parsed.data.accepted && parsed.data.sessionId === undefined) {
			// An accept with no handle is worse than a refusal: the engine would hand the leg over and
			// have nothing to address the verbs at, so the call would sit silent until it timed out.
			return {
				accepted: false,
				reason: "internal",
				error: "the control plane accepted without a session id",
			};
		}
		if (parsed.data.accepted) {
			this.accepted += 1;
			this.logger.info(
				{
					orgId: request.orgId,
					application: request.application,
					callId: request.callId,
					sessionId: parsed.data.sessionId,
					instanceId: this.env.ENGINE_INSTANCE_ID,
				},
				"an application took control of a call",
			);
		}
		return parsed.data;
	}
}
