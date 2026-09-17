import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { connect, type KV, type NatsConnection } from "nats";
import { natsConnectionOptions } from "@optimiq-voice/config/nats-credentials";
import {
	CALL_CONTROL_RPC,
	callControlResponseSchema,
	liveChannelSchema,
} from "@optimiq-voice/events/schemas";
import { CHANNELS_KV } from "@optimiq-voice/events/streams";
import { subjectFor } from "@optimiq-voice/events/subjects";
import { getLogger } from "@optimiq-voice/logging";
import { PBX_ENV } from "../shared/pbx.tokens";
import type { PbxEnv } from "../shared/pbx-env";
import type { CallControlRequest, CallControlResponse } from "@optimiq-voice/events/schemas";

const logger = getLogger("api.calls");

/**
 * The control plane's half of `rpc.engine.v1.call-control`: find the engine holding a PBX call, and
 * ask it.
 *
 * ## Where the address comes from
 *
 * The `channels` bucket, keyed `<orgId>.<callId>.<legId>`, whose every value carries
 * `variables.OPTIMIQ_ENGINE_INSTANCE_ID`. That is the same lookup a park retrieval makes against
 * `park-claims` and in-conference moderation makes against `conference-claims` — and against a
 * bucket this identity ALREADY reads for the live-calls topic, so the surface cost no new grant.
 *
 * A key-range read rather than a single `get`, because the caller has a CALL and the key needs a
 * leg. The range is one call's legs — two in the ordinary bridged case, a handful in a ring group —
 * on a path driven by a person pressing a button.
 *
 * ## Read-only on the bucket, deliberately
 *
 * `config/nats.conf` grants this identity SUBSCRIBE on `$KV.channels.>` and not publish, on
 * `ConferenceControlClient`'s argument: a channel snapshot is the engine's own record of a live leg,
 * and a control plane that could write one could hand a call's ownership to an instance that is not
 * on it.
 *
 * ## Its own connection, like `SessionHub`'s and `ConferenceControlClient`'s
 *
 * Raw request-reply on a subject whose last token is an instance id, which no Nest `ClientProxy`
 * can express. Sharing the live hub's connection would also couple a PCI pause's availability to a
 * wallboard's watch.
 */
@Injectable()
export class CallControlClient implements OnModuleInit, OnApplicationShutdown {
	private connection: NatsConnection | undefined;
	private channels: KV | undefined;
	private stopped = false;
	private relayed = 0;

	constructor(@Inject(PBX_ENV) private readonly env: PbxEnv) {}

	get isReady(): boolean {
		return (
			this.connection !== undefined && !this.connection.isClosed() && this.channels !== undefined
		);
	}

	get stats(): { readonly relayed: number; readonly channelsBound: boolean } {
		return { relayed: this.relayed, channelsBound: this.channels !== undefined };
	}

	async onModuleInit(): Promise<void> {
		if (this.env.NATS_URL === undefined) {
			logger.warn(
				"NATS_URL is not set — a recording pause on a PBX call will refuse rather than " +
					"silently succeeding, because a pause nobody applied is worse than one that failed.",
			);
			return;
		}
		try {
			this.connection = await connect({
				servers: this.env.NATS_URL,
				...natsConnectionOptions(this.env, "api"),
				name: "optimiq-api-call-control",
				maxReconnectAttempts: -1,
				reconnectTimeWait: 1_000,
			});
			const manager = await this.connection.jetstreamManager();
			// NOT created here. The engines own this bucket and this process may not write it.
			this.channels = await manager.jetstream().views.kv(CHANNELS_KV.name);
			logger.info("PBX recording control connected");
		} catch (error) {
			// A deployment whose engines have never run has no bucket, which is a real state and must
			// not stop the api booting. Every command then refuses with a reason.
			logger.warn({ err: error }, "PBX recording control could not bind the channels bucket");
		}
	}

	async onApplicationShutdown(): Promise<void> {
		this.stopped = true;
		if (this.connection !== undefined && !this.connection.isClosed()) {
			await this.connection.drain();
		}
		this.connection = undefined;
		this.channels = undefined;
	}

	/**
	 * The engine instances holding live legs of this call, in a stable order.
	 *
	 * Empty when the call is not live anywhere — which is the honest answer to "can this be paused?"
	 * and is what turns a pause on an ended call into a 404 rather than a timed-out request.
	 *
	 * De-duplicated because a bridged call is two legs and, in every deployment that is not
	 * mid-scale-out, one engine. Sorted so a retry hits the same instance first: nothing depends on
	 * WHICH instance answers — exactly one holds the recorder — but a deterministic order makes a
	 * log line reproducible, which is `ConferenceControlClient.contributors`' rule.
	 */
	async ownersOf(organizationId: string, callId: string): Promise<readonly string[]> {
		const bucket = this.channels;
		if (bucket === undefined) {
			return [];
		}
		const owners = new Set<string>();
		try {
			// Drained before a single value is read, for the reason `LiveHub.snapshot` records at
			// length: `keys()` is an ordered JetStream consumer and it does not survive a `get` issued
			// inside the iteration — it sees a gap, resets, and ends early.
			const keys: string[] = [];
			for await (const key of await bucket.keys(`${organizationId}.${callId}.>`)) {
				keys.push(key);
			}
			const entries = await Promise.all(keys.map(async (key) => await bucket.get(key)));
			for (const entry of entries) {
				if (entry === null || entry.value.length === 0) {
					continue;
				}
				const parsed = liveChannelSchema.safeParse(
					JSON.parse(new TextDecoder().decode(entry.value)) as unknown,
				);
				// The tenancy check the key already implies, made again at the one place a mistake
				// would be visible to a user — the same belt-and-braces `LiveHub` applies on fan-out.
				if (!parsed.success || parsed.data.organizationId !== organizationId) {
					continue;
				}
				const owner = (parsed.data as { variables?: Record<string, unknown> }).variables?.[
					CHANNEL_OWNER_INSTANCE_VARIABLE
				];
				if (typeof owner === "string" && owner.length > 0) {
					owners.add(owner);
				}
			}
		} catch (error) {
			logger.warn({ organizationId, callId, err: error }, "could not read a call's channels");
			return [];
		}
		return [...owners].sort();
	}

	/**
	 * Sends one command to one engine instance.
	 *
	 * A REFUSAL and never a throw, the contract `session-hub.service.ts` and
	 * `conference-control.client.ts` both hold to for the same caller-shaped reason: the thing
	 * waiting is an HTTP request with a person behind it, and "no responders available" (the
	 * instance is gone) and a timeout (it is wedged) mean the same thing to them.
	 */
	async send(instanceId: string, request: CallControlRequest): Promise<CallControlResponse> {
		const connection = this.connection;
		if (connection === undefined || connection.isClosed() || this.stopped) {
			return this.refuse(instanceId, request, "the control plane has no broker connection");
		}
		try {
			const reply = await connection.request(
				subjectFor.engineCallControlRpc(instanceId),
				new TextEncoder().encode(JSON.stringify(request)),
				{ timeout: CALL_CONTROL_RPC.timeoutMs },
			);
			const parsed = callControlResponseSchema.safeParse(
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
		request: CallControlRequest,
		error: string,
	): CallControlResponse {
		return {
			ok: false,
			verb: request.verb,
			instanceId,
			reason: "internal",
			error: `${LOCALLY_SYNTHESISED_REFUSAL}${error}`.slice(0, 512),
		};
	}
}

/**
 * Prefix on the `error` of a refusal this file synthesised rather than received.
 *
 * The same marker, and the same argument, as `conference-control.client.ts`: the response
 * contract's `reason` set describes what an ENGINE decided and has no code for "the engine could
 * not be asked". A caller walking several owners has to tell those apart — a dead instance is not
 * evidence that the call is not on the next one.
 */
export const LOCALLY_SYNTHESISED_REFUSAL = "unreachable: ";

/**
 * The channel variable that names the engine holding a leg.
 *
 * Copied rather than imported: it is `apps/engine`'s own constant
 * (`nats/channel-ownership.ts`), and the api does not depend on the engine. Pinned by
 * `test/pbx/callRecordingControl.test.ts`.
 */
const CHANNEL_OWNER_INSTANCE_VARIABLE = "OPTIMIQ_ENGINE_INSTANCE_ID";
