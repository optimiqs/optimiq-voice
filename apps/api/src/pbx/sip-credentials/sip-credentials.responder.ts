import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { connect, type NatsConnection, type Subscription } from "nats";
import { natsConnectionOptions } from "@optimiq-voice/config/nats-credentials";
import { sipCredentialRequestSchema } from "@optimiq-voice/events/schemas";
import { RPC_SUBJECTS } from "@optimiq-voice/events/subjects";
import { getLogger } from "@optimiq-voice/logging";
import { PBX_ENV } from "../shared/pbx.tokens";
import { SipCredentialsService } from "./sip-credentials.service";
import type { PbxEnv } from "../shared/pbx-env";
import type { SipCredentialResponse } from "@optimiq-voice/events/schemas";

const logger = getLogger("api.pbx");

/**
 * The `rpc.sip.v1.credential` responder — the other end of `apps/sipd`'s digest challenge.
 *
 * ## Why this is a raw subscription and NOT a `@MessagePattern` controller
 *
 * Every other `rpc.*` subject in this area is a Nest `@MessagePattern`
 * (`routing-rpc.controller.ts`, `voicemail-rpc.controller.ts`), and this one started that way too.
 * It cannot stay that way, for a reason that is invisible until the first non-TypeScript caller
 * arrives — which is exactly what `apps/sipd` is.
 *
 * NestJS's NATS transport does not speak the subject's payload. It speaks its own request-reply
 * framing:
 *
 * ```text
 * request   {"pattern":"rpc.sip.v1.credential","data":{…the contract…},"id":"…"}
 * reply     {"response":{…the contract…},"isDisposed":true,"id":"…"}
 * ```
 *
 * A request carrying the contract's own JSON is **never answered at all** — measured, not assumed:
 * a raw request times out against both this subject and `rpc.routing.v1.resolve`, while the same
 * request wrapped in Nest's envelope is answered immediately. `apps/engine` already documents the
 * mirror image of this for events (`src/nats/envelope.serializer.ts`: "NestJS's NATS transport
 * serializes an emitted event as `{...packet, data}` … a Go consumer would not unmarshal these at
 * all") and strips the wrapper with a custom serializer. Its note that "REQUEST-REPLY must keep
 * Nest's default" was correct at the time, because every RPC caller in the repository was itself a
 * Nest client.
 *
 * `packages/events` is the contract, and it generates `SipCredentialRequest` /
 * `SipCredentialResponse` into `packages/events-go` from the same schemas. Those structs describe
 * the payload, not a framework's envelope. The choice is therefore between:
 *
 * 1. teaching `apps/sipd` NestJS's private wire format — putting a TypeScript framework's internal
 *    protocol into a Go data-plane service, permanently, for every future cross-language RPC; or
 * 2. serving this one subject with the raw client the area already uses for KV.
 *
 * (2). The contract stays the thing on the wire, which is the property the whole codegen pipeline
 * exists to guarantee.
 *
 * ## Its own connection, and why that is acceptable here
 *
 * `RoutingCachePublisher` opens its own connection for KV, and this opens one for request-reply,
 * because the Nest transport's connection is not exposed and sharing one across a subscription and
 * a KV view would couple two lifecycles for no gain. Two connections to the same broker from one
 * process is a socket, not an architecture.
 *
 * ## Absent broker
 *
 * `NATS_URL` is optional, exactly as it is for the routing cache. Without it this never subscribes
 * and logs the consequence once — no phone can register — rather than refusing to boot. A control
 * plane that would not start without the backbone could not be used to fix the backbone.
 */
@Injectable()
export class SipCredentialsResponder implements OnModuleInit, OnApplicationShutdown {
	private connection: NatsConnection | undefined;
	private subscription: Subscription | undefined;
	private handled = 0;

	constructor(
		@Inject(PBX_ENV) private readonly env: PbxEnv,
		@Inject(SipCredentialsService) private readonly credentials: SipCredentialsService,
	) {}

	get isReady(): boolean {
		return this.subscription !== undefined && this.connection?.isClosed() === false;
	}

	get handledCount(): number {
		return this.handled;
	}

	async onModuleInit(): Promise<void> {
		if (this.env.NATS_URL === undefined) {
			logger.warn(
				`NATS_URL is not set — ${RPC_SUBJECTS.sipCredential} is not served, so no SIP device ` +
					"can register against apps/sipd. PBX CRUD is unaffected.",
			);
			return;
		}

		try {
			this.connection = await connect({
				servers: this.env.NATS_URL,
				...natsConnectionOptions(this.env, "api"),
				name: "optimiq-api-sip-credentials",
				maxReconnectAttempts: -1,
				reconnectTimeWait: 1_000,
			});
		} catch (error) {
			// A broker that is down must not stop the control plane from serving configuration
			// changes — the same posture the routing cache takes.
			logger.error({ err: error }, `could not subscribe to ${RPC_SUBJECTS.sipCredential}`);
			return;
		}

		// A queue group, so N API replicas share the load and exactly one answers each REGISTER.
		// Without it every replica would answer, and the registrar would take whichever reply
		// arrived first while the rest became garbage on the wire.
		this.subscription = this.connection.subscribe(RPC_SUBJECTS.sipCredential, {
			queue: "optimiq-api-sip-credentials",
		});
		void this.consume(this.subscription);

		logger.info(
			{
				servers: this.env.NATS_URL,
			},
			`serving ${RPC_SUBJECTS.sipCredential} over NATS`,
		);
	}

	private async consume(subscription: Subscription): Promise<void> {
		const decoder = new TextDecoder();
		const encoder = new TextEncoder();

		for await (const message of subscription) {
			this.handled += 1;
			let reply: SipCredentialResponse;
			try {
				reply = await this.answer(decoder.decode(message.data));
			} catch (error) {
				// Unreachable in principle — `answer` catches — but a throw here would end the
				// iterator and silently stop serving the subject for the life of the process.
				logger.error({ err: error }, `${RPC_SUBJECTS.sipCredential} handler threw`);
				reply = refuse("credential lookup failed");
			}

			try {
				message.respond(encoder.encode(JSON.stringify(reply)));
			} catch (error) {
				logger.error({ err: error }, `could not reply on ${RPC_SUBJECTS.sipCredential}`);
			}
		}
	}

	/**
	 * Answer, never throw.
	 *
	 * The registrar is inside a REGISTER transaction with a 500 ms deadline. An unanswered request
	 * is indistinguishable from a dead API and arrives after the phone has already retransmitted,
	 * so every path — including a malformed payload and a database failure — produces a reply.
	 */
	private async answer(raw: string): Promise<SipCredentialResponse> {
		let payload: unknown;
		try {
			payload = JSON.parse(raw) as unknown;
		} catch {
			logger.warn(`rejected a non-JSON ${RPC_SUBJECTS.sipCredential} request`);
			return refuse("the request was not JSON");
		}

		const parsed = sipCredentialRequestSchema.safeParse(payload);
		if (!parsed.success) {
			// Version skew across two deployables is expected, not impossible.
			const reason = parsed.error.issues
				.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
				.join("; ");
			logger.warn({ reason }, `rejected a malformed ${RPC_SUBJECTS.sipCredential} request`);
			return refuse(reason);
		}

		try {
			return await this.credentials.resolve({
				realm: parsed.data.realm,
				username: parsed.data.username,
				sourceAddress: parsed.data.sourceAddress,
			});
		} catch (error) {
			logger.error(
				{
					realm: parsed.data.realm,
					username: parsed.data.username,
					sourceAddress: parsed.data.sourceAddress,
					error,
				},
				`${RPC_SUBJECTS.sipCredential} failed`,
			);
			return refuse(
				`credential lookup failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async onApplicationShutdown(): Promise<void> {
		const subscription = this.subscription;
		this.subscription = undefined;
		if (subscription !== undefined) {
			// `drain` lets an in-flight REGISTER finish being answered rather than cutting it off.
			await subscription.drain().catch(() => undefined);
		}

		const connection = this.connection;
		this.connection = undefined;
		if (connection && !connection.isClosed()) {
			await connection.drain().catch(() => undefined);
		}
	}
}

/**
 * A failure is reported as `found: false`, never as `found: true` with no `ha1`.
 *
 * The registrar fails closed on both — its `credentialFromReply` treats "usable account, no hash"
 * as a transport-level fault — but `found: false` already means "refuse this REGISTER", so it is
 * the shape that cannot be misread by an older sipd.
 *
 * The `reason` is for the operator reading these logs. It never reaches the phone: the registrar
 * answers a bare 403.
 */
function refuse(reason: string): SipCredentialResponse {
	return { found: false, enabled: false, reason: reason.slice(0, 256) };
}
