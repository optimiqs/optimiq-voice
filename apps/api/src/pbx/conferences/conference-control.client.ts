import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { connect, type KV, type NatsConnection } from "nats";
import { natsConnectionOptions } from "@optimiq-voice/config/nats-credentials";
import {
	CONFERENCE_CONTROL_RPC,
	conferenceClaimSchema,
	conferenceControlResponseSchema,
} from "@optimiq-voice/events/schemas";
import { CONFERENCE_CLAIMS_KV, kvKeyFor } from "@optimiq-voice/events/streams";
import { subjectFor } from "@optimiq-voice/events/subjects";
import { getLogger } from "@optimiq-voice/logging";
import { PBX_ENV } from "../shared/pbx.tokens";
import type { PbxEnv } from "../shared/pbx-env";
import type {
	ConferenceClaim,
	ConferenceControlRequest,
	ConferenceControlResponse,
} from "@optimiq-voice/events/schemas";

const logger = getLogger("api.pbx");

/**
 * The control plane's half of in-conference moderation: find the engines holding a room, and ask
 * them.
 *
 * ## Where the address comes from, and why it is not a directory
 *
 * A moderation command names ONE MEMBER of ONE room, and only the engine instance holding that
 * member's media channel can act on it. There is no announcement to learn the owner from — nothing
 * announces a conference to the control plane, unlike a session, whose `instanceId` arrives on the
 * offer and is held for the life of the socket.
 *
 * So the address is read out of `conference-claims`, the KV value the engines already maintain to
 * agree on a room's bridge. Its `contributions` map is keyed by INSTANCE ID and carries, per
 * instance, how many members it holds and when that contribution expires. That is exactly the list
 * of engines worth asking, it is leased so a crashed instance drops off it, and it is written on a
 * path that has to succeed anyway — a join that could not record its claim is refused.
 *
 * The command is then addressed at each unexpired contributor in turn until one answers something
 * other than "not mine". On a single-instance deployment that is one request; on a room split
 * across three engines it is at most three, on a path driven by an operator clicking a button.
 *
 * ## What the alternative would have cost
 *
 * A per-member ownership directory: a KV write on every join, a delete on every leave, a reaper for
 * every crashed instance's orphans, and a second source of truth about who is in a room that could
 * disagree with the claim. All to save two requests on a human-speed path. Recorded here because
 * "why is this a fan-out?" is the first question a reader has.
 *
 * ## Read-only on the bucket, deliberately
 *
 * `config/nats.conf` grants this identity SUBSCRIBE on `$KV.conference-claims.>` and not publish. A
 * claim is an ownership record between engine instances, and a control plane that could write one
 * could hand a live room's bridge to an instance that is not in it — the split-brain the claim
 * exists to prevent, caused by the one process that is not on the call path.
 *
 * ## Its own connection, like `SessionHub`'s
 *
 * Raw request-reply on a subject whose last token is an instance id, which no Nest `ClientProxy`
 * can express and whose framing the engine does not unwrap. Sharing the live hub's connection would
 * also couple a moderation button's availability to a wallboard's watch.
 */
@Injectable()
export class ConferenceControlClient implements OnModuleInit, OnApplicationShutdown {
	private connection: NatsConnection | undefined;
	private claims: KV | undefined;
	private stopped = false;
	private relayed = 0;

	constructor(@Inject(PBX_ENV) private readonly env: PbxEnv) {}

	get isReady(): boolean {
		return this.connection !== undefined && !this.connection.isClosed();
	}

	get stats(): { readonly relayed: number; readonly claimsBound: boolean } {
		return { relayed: this.relayed, claimsBound: this.claims !== undefined };
	}

	async onModuleInit(): Promise<void> {
		if (this.env.NATS_URL === undefined) {
			logger.warn(
				"NATS_URL is not set — conference moderation will refuse every command rather than " +
					"silently succeeding, because a mute nobody applied is worse than a mute that failed.",
			);
			return;
		}
		try {
			this.connection = await connect({
				servers: this.env.NATS_URL,
				...natsConnectionOptions(this.env, "api"),
				name: "optimiq-api-conference-control",
				maxReconnectAttempts: -1,
				reconnectTimeWait: 1_000,
			});
			const manager = await this.connection.jetstreamManager();
			// NOT created here, even under `PBX_ENSURE_KV_BUCKETS`. The engines own this bucket and this
			// process may not write it; a control plane that created it would be deciding its replicas
			// and its history for the processes that actually depend on it.
			this.claims = await manager.jetstream().views.kv(CONFERENCE_CLAIMS_KV.name);
			logger.info("conference moderation connected");
		} catch (error) {
			// A deployment with no claim bucket yet is a real state — no conference has ever run — and
			// it must not stop the api booting. Every command then refuses with a reason.
			logger.warn({ err: error }, "conference moderation could not bind the claim bucket");
		}
	}

	async onApplicationShutdown(): Promise<void> {
		this.stopped = true;
		if (this.connection !== undefined && !this.connection.isClosed()) {
			await this.connection.drain();
		}
		this.connection = undefined;
		this.claims = undefined;
	}

	/**
	 * The room's claim, or `undefined` when nobody is in it.
	 *
	 * Also the answer to "is this meeting running?", which is the only thing the control plane can
	 * know about a live room without asking an engine — and is what turns a moderation command on a
	 * room nobody has joined into a 404 rather than three timed-out requests.
	 */
	async claim(organizationId: string, conferenceId: string): Promise<ConferenceClaim | undefined> {
		const bucket = this.claims;
		if (bucket === undefined) {
			return undefined;
		}
		try {
			const entry = await bucket.get(kvKeyFor.conferenceClaim(organizationId, conferenceId));
			if (entry === null || entry.value.length === 0) {
				return undefined;
			}
			const parsed = conferenceClaimSchema.safeParse(
				JSON.parse(new TextDecoder().decode(entry.value)) as unknown,
			);
			if (!parsed.success) {
				logger.warn(
					{ organizationId, conferenceId },
					"dropping a conference claim that does not match its contract",
				);
				return undefined;
			}
			// The tenancy check the key already implies, made again at the one place a mistake would be
			// visible to a user. The same belt-and-braces `live-hub.service.ts` applies on fan-out.
			return parsed.data.orgId === organizationId ? parsed.data : undefined;
		} catch (error) {
			logger.warn(
				{ organizationId, conferenceId, err: error },
				"could not read a conference claim",
			);
			return undefined;
		}
	}

	/**
	 * Every engine instance with unexpired members in the room, in a stable order.
	 *
	 * Expired contributions are dropped for the reason the engine drops them: an instance that
	 * stopped heartbeating has crashed, its seats no longer count, and addressing it costs a full
	 * request timeout on a path a person is waiting on.
	 *
	 * Sorted so a retry hits the same instance first. Nothing depends on WHICH instance answers —
	 * exactly one holds the member — but a deterministic order makes a log line reproducible.
	 */
	contributors(claim: ConferenceClaim, nowMs = Date.now()): readonly string[] {
		return Object.entries(claim.contributions)
			.filter(([, contribution]) => contribution.expiresAt > nowMs)
			.map(([instanceId]) => instanceId)
			.sort();
	}

	/**
	 * Sends one command to one engine instance.
	 *
	 * A REFUSAL and never a throw, which is the contract `session-hub.service.ts` holds to for the
	 * same caller-shaped reason: the thing waiting is an HTTP request with a person behind it, and
	 * "no responders available" (the instance is gone) and a timeout (it is wedged) mean the same
	 * thing to them — that engine cannot answer, try the next one.
	 */
	async send(
		instanceId: string,
		request: ConferenceControlRequest,
	): Promise<ConferenceControlResponse> {
		const connection = this.connection;
		if (connection === undefined || connection.isClosed() || this.stopped) {
			return this.refuse(instanceId, request, "the control plane has no broker connection");
		}
		try {
			const reply = await connection.request(
				subjectFor.engineConferenceControlRpc(instanceId),
				new TextEncoder().encode(JSON.stringify(request)),
				{ timeout: CONFERENCE_CONTROL_RPC.timeoutMs },
			);
			const parsed = conferenceControlResponseSchema.safeParse(
				JSON.parse(new TextDecoder().decode(reply.data)) as unknown,
			);
			if (!parsed.success) {
				return this.refuse(
					instanceId,
					request,
					"the engine answered with something that is not the contract",
				);
			}
			this.relayed += 1;
			return parsed.data;
		} catch (error) {
			return this.refuse(instanceId, request, String(error));
		}
	}

	private refuse(
		instanceId: string,
		request: ConferenceControlRequest,
		error: string,
	): ConferenceControlResponse {
		return {
			ok: false,
			action: request.action,
			instanceId,
			memberCount: 0,
			...(request.memberRef === undefined ? {} : { memberRef: request.memberRef }),
			// `internal` and not `unknown-member`: the difference decides whether the caller keeps
			// trying contributors, and an unreachable engine is not evidence that the member is
			// somewhere else.
			reason: "internal",
			error: error.slice(0, 512),
		};
	}
}
