import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { connect, type NatsConnection, type Subscription } from "nats";
import { natsConnectionOptions } from "@optimiq-voice/config/nats-credentials";
import { authorizeOutboundRequestSchema } from "@optimiq-voice/events/schemas";
import { RPC_SUBJECTS } from "@optimiq-voice/events/subjects";
import { getLogger } from "@optimiq-voice/logging";
import { and, eq, extension, orgSetting } from "@optimiq-voice/pbx-db";
import { PBX_DATABASE, PBX_ENV } from "../shared/pbx.tokens";
import { TollFraudService } from "./toll-fraud.service";
import type { PbxEnv } from "../shared/pbx-env";
import type { AuthorizeOutboundResponse } from "@optimiq-voice/events/schemas";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.pbx");

/** Concurrent authorizations per replica. Each is three indexed reads on one connection. */
const MAX_IN_FLIGHT = 32;

/** The one answer every failure path here gives. See the class header on failing open. */
const ALLOW: AuthorizeOutboundResponse = { allowed: true };

/**
 * `rpc.pbx.v1.authorize-outbound` — the toll-fraud gate, answered for `apps/engine` at dial time.
 *
 * ## Why the engine has to ask
 *
 * The CEILINGS are already on the artifact (`CompiledRoutingSettings.tollFraud`), because they are
 * configuration and the engine holds no database handle. Four things cannot be: the rolling
 * international-minute counters, the live concurrency gauge, the countries this organization has
 * been seen calling, and the per-extension override and suspension. Every one of them changes
 * between compiles by definition, so an artifact carrying them would be wrong the moment it was
 * published — and a fraud control that is wrong in the permissive direction is not a control.
 *
 * ## Failing OPEN, which is the uncomfortable half
 *
 * Every failure on this path answers `{ allowed: true }`: an unparseable request, a database that
 * will not answer, an unexpected throw. That means a control-plane outage disarms the fraud control,
 * and it is still right. The alternative is that a slow database bars every international call on
 * the platform — a total outbound outage, arriving in seconds, at every tenant at once, with no
 * fraud in progress. One of those two failures is recoverable by waiting; the other is an incident.
 *
 * The engine treats a TIMEOUT the same way, so the two ends agree, and the anomaly detector is the
 * backstop that still notices afterwards from the call records.
 *
 * ## A raw subscription, not a `@MessagePattern`
 *
 * `sip-credentials.responder.ts` records the full argument and it applies verbatim: NestJS's NATS
 * transport wraps the payload in its own request-reply envelope, `packages/events-go` generates
 * structs that describe the CONTRACT rather than a framework's envelope, and the caller here is the
 * engine reading that contract. The contract stays the thing on the wire.
 */
@Injectable()
export class TollFraudResponder implements OnModuleInit, OnApplicationShutdown {
	private connection: NatsConnection | undefined;
	private subscription: Subscription | undefined;
	private stopped = false;
	private handled = 0;
	private refused = 0;
	private failedOpen = 0;
	private readonly inFlight = new Set<Promise<void>>();

	constructor(
		@Inject(PBX_ENV) private readonly env: PbxEnv,
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		@Inject(TollFraudService) private readonly tollFraud: TollFraudService,
	) {}

	get stats(): {
		readonly handled: number;
		readonly refused: number;
		readonly failedOpen: number;
	} {
		return { handled: this.handled, refused: this.refused, failedOpen: this.failedOpen };
	}

	async onModuleInit(): Promise<void> {
		if (this.env.NATS_URL === undefined) {
			logger.warn(
				`NATS_URL is not set — ${RPC_SUBJECTS.pbxAuthorizeOutbound} is not served, so the engine ` +
					"enforces no spend or velocity ceiling at dial time. The engine fails open on a " +
					"timeout, so calls still place; the anomaly detector is the only control left.",
			);
			return;
		}
		try {
			this.connection = await connect({
				servers: this.env.NATS_URL,
				...natsConnectionOptions(this.env, "api"),
				name: "optimiq-api-toll-fraud",
				maxReconnectAttempts: -1,
				reconnectTimeWait: 1_000,
			});
		} catch (error) {
			logger.error({ err: error }, `could not subscribe to ${RPC_SUBJECTS.pbxAuthorizeOutbound}`);
			return;
		}
		void this.serve();
		logger.info(
			{ servers: this.env.NATS_URL },
			`serving ${RPC_SUBJECTS.pbxAuthorizeOutbound} over NATS`,
		);
	}

	async onApplicationShutdown(): Promise<void> {
		this.stopped = true;
		this.subscription?.unsubscribe();
		this.subscription = undefined;
		await Promise.allSettled(this.inFlight);
		const connection = this.connection;
		this.connection = undefined;
		if (connection && !connection.isClosed()) {
			await connection.drain();
		}
	}

	/**
	 * Subscribes, consumes, and re-subscribes for the life of the process.
	 *
	 * The same shape `SipCredentialsResponder.serve` uses and for the same reason: the `for await`
	 * itself can reject, and left as a bare `void`ed promise that is an unhandled rejection which
	 * takes the control plane down — or, survived, silently stops serving the subject.
	 */
	private async serve(): Promise<void> {
		let backoffMs = 1_000;
		while (!this.stopped) {
			const connection = this.connection;
			if (connection === undefined || connection.isClosed()) {
				return;
			}
			try {
				// A queue group, so N replicas share the load and exactly one answers each dial.
				const subscription = connection.subscribe(RPC_SUBJECTS.pbxAuthorizeOutbound, {
					queue: "optimiq-api-toll-fraud",
				});
				this.subscription = subscription;
				backoffMs = 1_000;
				for await (const message of subscription) {
					if (this.stopped) {
						break;
					}
					// Shed rather than queue: this request has a 400ms deadline at the other end, and a
					// backlog answers requests whose callers have already given up while making the next
					// one late too. A shed request is a timeout, and a timeout fails open — which is the
					// same answer an overloaded responder would eventually give more slowly.
					if (this.inFlight.size >= MAX_IN_FLIGHT) {
						this.failedOpen += 1;
						message.respond(encode(ALLOW));
						continue;
					}
					const work = this.handle(message.data)
						.then((response) => {
							message.respond(encode(response));
						})
						.catch((error: unknown) => {
							this.failedOpen += 1;
							logger.error({ err: error }, "the toll-fraud gate failed; allowing the call");
							message.respond(encode(ALLOW));
						});
					this.inFlight.add(work);
					void work.finally(() => this.inFlight.delete(work));
				}
			} catch (error) {
				logger.error(
					{ err: error, subject: RPC_SUBJECTS.pbxAuthorizeOutbound },
					"the toll-fraud subscription ended; re-subscribing",
				);
			}
			this.subscription = undefined;
			if (this.stopped) {
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, backoffMs));
			backoffMs = Math.min(backoffMs * 2, 30_000);
		}
	}

	/**
	 * One authorization. Exported through the class so a spec can call it without a broker.
	 *
	 * `extensionNumber` is treated as a CLAIM and resolved inside the tenant, exactly as
	 * `extension-feature`'s responder treats it: the engine is trusted to name its own organization
	 * (it read that from the artifact it was given) and is not trusted to assert that a number
	 * belongs to it. A number that resolves to nothing is evaluated against the ORGANIZATION policy
	 * alone rather than refused — a call from a trunk or an API-originated leg genuinely has no
	 * extension, and refusing those would bar exactly the traffic the gate is least suspicious of.
	 */
	async handle(payload: Uint8Array): Promise<AuthorizeOutboundResponse> {
		const parsed = authorizeOutboundRequestSchema.safeParse(unwrap(decode(payload)));
		if (!parsed.success) {
			this.failedOpen += 1;
			logger.warn({ issues: parsed.error.issues }, "an unparseable toll-fraud request; allowing");
			return ALLOW;
		}
		const request = parsed.data;
		this.handled += 1;
		const now = request.at === undefined ? new Date() : new Date(request.at);
		const target = await this.resolveExtension(request.orgId, request.extensionNumber);
		const verdict = await this.tollFraud.evaluate({
			organizationId: request.orgId,
			// The organization's own id stands in for an absent extension: the counters are metered at
			// the organization key regardless (see `TollFraudService.counters`), and the audit row then
			// names the tenant rather than an extension that does not exist.
			extensionId: target?.id ?? request.orgId,
			...(target?.number === undefined ? {} : { extensionNumber: target.number }),
			dialedE164: request.dialedNumber,
			now,
			timezone: await this.timezoneFor(request.orgId),
		});
		if (verdict.allowed) {
			return ALLOW;
		}
		this.refused += 1;
		return {
			allowed: false,
			...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
			detail:
				verdict.country === undefined
					? "Refused by this organization's toll-fraud policy."
					: `Refused by this organization's toll-fraud policy for destination country ${verdict.country}.`,
		};
	}

	private async resolveExtension(
		organizationId: string,
		number: string | undefined,
	): Promise<{ readonly id: string; readonly number: string } | undefined> {
		if (number === undefined) {
			return undefined;
		}
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const rows = await transaction
				.select({ id: extension.id, number: extension.number })
				.from(extension)
				.where(eq(extension.number, number))
				.limit(1);
			return rows[0];
		});
	}

	/**
	 * The organization's IANA zone, for the off-hours window alone.
	 *
	 * `UTC` when unset, which is the same fallback the routing compiler applies to a tenant with no
	 * `defaultTimezone` — so a tenant who has configured neither gets one consistent answer rather
	 * than a lock that fires at a different hour depending on which process evaluated it.
	 */
	private async timezoneFor(organizationId: string): Promise<string> {
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const rows = await transaction
				.select({ value: orgSetting.value })
				.from(orgSetting)
				.where(
					and(
						eq(orgSetting.category, "routing"),
						eq(orgSetting.name, "defaultTimezone"),
						eq(orgSetting.enabled, true),
					),
				)
				.limit(1);
			const value = rows[0]?.value;
			return typeof value === "string" && value.trim().length > 0 ? value.trim() : "UTC";
		});
	}
}

function encode(value: AuthorizeOutboundResponse): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(value));
}

/**
 * The contract payload, whichever of the two shapes it arrived in.
 *
 * ## Why two shapes exist at all
 *
 * This is a RAW subscription — the class header states why, and the reason stands: `apps/sipd` and
 * `packages/events-go` speak the CONTRACT, not a framework's envelope. But the only caller today is
 * `apps/engine`, and the engine asks through a NestJS `ClientProxy`, which wraps every request in
 * `{ pattern, data, id }` before it hits the wire. So the request arrived as an envelope whose
 * `orgId` and `dialedNumber` were both `undefined`, every call failed open with
 * "an unparseable toll-fraud request", and the gate was never once consulted on a live call. It is
 * the exact failure a fail-open control has: it is silent, and it looks like nothing.
 *
 * Unwrapping is the smaller of the two fixes. Making the engine send raw NATS would mean a second
 * NATS connection in the engine beside the `ClientProxy` it already holds, for one call; while
 * moving this to a `@MessagePattern` would put a framework envelope on a subject `events-go` is
 * generated for. Accepting both shapes costs one function and keeps every future caller — a Go
 * edge, a `ClientProxy`, a `nats` CLI probe — working.
 *
 * The `data` key is only unwrapped when the envelope's own `pattern` is present too, so a genuine
 * contract payload that happened to have a `data` field of its own is never mistaken for one.
 */
function unwrap(value: unknown): unknown {
	if (typeof value !== "object" || value === null) {
		return value;
	}
	const record = value as Record<string, unknown>;
	return "pattern" in record && "data" in record ? record["data"] : value;
}

function decode(payload: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder().decode(payload));
	} catch {
		return undefined;
	}
}
