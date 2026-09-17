import { headers, type NatsConnection } from "nats";
import {
	SIP_ANSWER_RPC,
	SIP_HANGUP_RPC,
	SIP_ORIGINATE_RPC,
	SIP_RESOLVE_TARGET_RPC,
	RPC_SUBJECTS,
	SIP_REINVITE_RPC,
	SIP_RING_RPC,
	sipAnswerResponseSchema,
	sipHangupResponseSchema,
	sipOriginateResponseSchema,
	sipResolveTargetResponseSchema,
	sipReinviteResponseSchema,
	sipRingResponseSchema,
	subjectFor,
} from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { RpcLatency } from "./rpc-latency";
import type { RpcLatencyReport } from "./rpc-latency";
import type {
	SipAnswerRequest,
	SipAnswerResponse,
	SipDialogRefusalReason,
	SipHangupRequest,
	SipHangupResponse,
	SipOriginateRequest,
	SipOriginateResponse,
	SipResolveTargetRequest,
	SipResolveTargetResponse,
	SipReinviteRequest,
	SipReinviteResponse,
	SipRingRequest,
	SipRingResponse,
} from "@optimiq-voice/events";

/**
 * The engine's client for `rpc.sip.v1.{ring,answer,hangup,reinvite,originate}` — the dialog command
 * surface `apps/sipd` serves.
 *
 * ## Raw NATS, because the responder is Go
 *
 * The same sentence `MediadTransport`'s doc comment calls the most important line in its directory,
 * with a different responder on the far end. NestJS's NATS transport does not put a payload on the
 * wire, it wraps it as `{pattern, data, id}`; `apps/sipd` unmarshals the bare contract struct. Handed
 * a `ClientProxy` frame it would see a request with no `legId`, refuse it `bad_request`, and answer
 * in a shape the `ClientProxy` would not recognise either — so the visible symptom is "every call
 * rings forever and is never answered", three layers away from the serializer that caused it. The
 * engine already holds a raw connection for JetStream and KV, so speaking raw here costs nothing.
 *
 * ## Instance-addressed, except for one
 *
 * Four of the five subjects carry the edge instance's token, because a dialog lives on exactly one
 * process and no other one can answer, retransmit or BYE it (§6.1). `originate` is FLAT and
 * queue-grouped because it CREATES the dialog and has no owner to find — and **the reply's
 * `instanceId` is what the engine records for that leg and addresses every later command at**, which
 * is the same pattern `mediaAllocateSessionResponseSchema.instanceId` established for a media
 * session. A caller that ignored it would address the leg's BYE at whichever edge the broker happened
 * to pick next, and get `unknown_dialog` from a process that never had the call.
 *
 * ## Refusals are DATA; only the unreachable is synthesised
 *
 * `MediadMediaPort` throws a typed error on a refusal because it implements `MediaPort`, whose 24
 * methods have return types with no room for "no". This client has room: every response schema on
 * this family carries `ok`, `reason` and `error`, so a refusal is returned and the caller branches on
 * it. That is the `safeParse`-and-return shape `apps/api`'s `SessionHubService.sendVerb` uses, and
 * the reason it is right here too: a `dialog_gone` is a normal outcome of a race the contract
 * documents (§4.4), and turning a documented outcome into an exception makes every call site write a
 * `try` around the ordinary path.
 *
 * What IS synthesised is the case where no reply arrived or the bytes were not the contract. Those
 * come back as `{ok: false, reason: "internal"}` with the detail in `error`, and the choice of
 * `internal` over `wrong_instance` is deliberate: `wrong_instance` means "ask the owner", and there
 * is nobody to ask when a `no responders available` came back — the instance holding that dialog is
 * gone and the dialog is gone with it (§6.4). The caller's move in every one of those cases is the
 * same (tear the leg down and write the CDR), so drawing a distinction the caller cannot act on would
 * be decoration.
 *
 * ## Timeouts come from the contract, never from a literal
 *
 * Each deadline is argued once, in `packages/events/src/schemas/rpc.ts`, and read from there. `answer`
 * is one second and NOT the thirty-two seconds its SIP transaction can take, because the edge replies
 * when the `200 OK` is on the socket and reports the ACK later as `dialog.answered`; a literal copied
 * into this file would drift from that argument the first time somebody tuned one of them.
 */

/**
 * What this client can be asked for, as a seam.
 *
 * An interface so the composite `MediaPort` — and every spec of it — can be driven with no broker,
 * exactly as `MediadTransport` is the seam that makes `MediadMediaPort` unit-testable. The
 * implementation below is the only part that touches the network.
 */
export interface SipdCommandPort {
	/** `180 Ringing`, or a `183` once early media ships. Addressed at the instance holding the leg. */
	ring(instanceId: string, request: SipRingRequest): Promise<SipRingResponse>;
	/** `200 OK` with this body. Replies when the 2xx is written, not when the ACK arrives. */
	answer(instanceId: string, request: SipAnswerRequest): Promise<SipAnswerResponse>;
	/** End this leg with this cause. The EDGE picks BYE, CANCEL or a final response. */
	hangup(instanceId: string, request: SipHangupRequest): Promise<SipHangupResponse>;
	/** Re-point or re-negotiate a confirmed dialog. Refused `not_supported` until slice 5. */
	reinvite(instanceId: string, request: SipReinviteRequest): Promise<SipReinviteResponse>;
	/**
	 * Place a call. Flat and queue-grouped: whichever edge answers becomes the leg's owner, and the
	 * reply's `instanceId` is what every later command on that leg must be addressed at.
	 */
	originate(request: SipOriginateRequest, instanceId?: string): Promise<SipOriginateResponse>;

	/**
	 * Per-command round-trip latency to the edge, since boot. OPTIONAL: a fake has nothing to report
	 * and a spec must not have to invent one. Read by `/healthz` through `SplitPlaneMediaPort`.
	 */
	readonly rpcLatency?: Record<string, RpcLatencyReport>;
	resolveTarget?(request: SipResolveTargetRequest): Promise<SipResolveTargetResponse>;
}

/**
 * The refusals that are a NORMAL outcome of a race or of stale state, not a fault to act on.
 *
 * `apps/sipd` already logs each of these once, and this client's own caller branches on the reason —
 * so a WARN here was the third copy of one fact and, at 2.4 lines a call on a stack with stale
 * bindings, the loudest thing in the log while saying nothing an operator could do. They stay at
 * DEBUG, where the leg id and the reason are still there for anyone reading one call.
 *
 * Everything NOT in this set stays WARN, deliberately: `internal`, `bad_request`, `capacity`,
 * `not_supported` and `shutting_down` each describe a fault, a limit or a build gap, and each is
 * something somebody should see.
 */
const EXPECTED_REFUSAL_REASONS: ReadonlySet<SipDialogRefusalReason> = new Set([
	// The dialog ended between the decision and the command — the ordinary teardown race.
	"unknown_dialog",
	"dialog_gone",
	// A `sipd` restarted and something still addresses the old token. The leg went with the process.
	"wrong_instance",
	// The caller's own state was stale: an answer on an answered call, a hangup on a dead one.
	"invalid_state",
	// Dialling outcomes, which the caller turns into a hangup cause and reports as the call's.
	"unregistered_target",
	"unknown_trunk",
	"no_route",
]);

/** {@link SipdCommandPort} over a live NATS connection. */
export class SipdCommandClient implements SipdCommandPort {
	private readonly logger = getLogger("engine.sipd-command");
	private readonly encoder = new TextEncoder();
	private readonly decoder = new TextDecoder();
	/**
	 * How long the SIP edge takes to answer, per command, reported on `/healthz`.
	 *
	 * A call setup is a chain of round trips this process does nothing but wait on, so none of it is
	 * visible in the engine's own CPU profile. This is the half of "why is setup slow" that belongs
	 * to the edge; `MediadService` carries the other half.
	 */
	private readonly latency = new RpcLatency();

	/**
	 * @param connectionOf reads the live connection each time rather than capturing it.
	 *
	 * An accessor and not a value, for the reason `NatsMediadTransport` states: Nest builds every
	 * provider BEFORE it initialises any of them, and the connection is opened in
	 * `JetStreamService.onModuleInit`. Capturing at construction would capture `undefined` on every
	 * boot and every command would refuse for the life of the process.
	 */
	constructor(private readonly connectionOf: () => NatsConnection | undefined) {}

	/** Per-command round-trip latency to the edge, since boot. Read by the health endpoint. */
	get rpcLatency(): Record<string, RpcLatencyReport> {
		return this.latency.snapshot;
	}

	/** Whether the client can reach a broker at all. Read by the health endpoint. */
	get isConnected(): boolean {
		const connection = this.connectionOf();
		return connection !== undefined && !connection.isClosed();
	}

	async ring(instanceId: string, request: SipRingRequest): Promise<SipRingResponse> {
		return await this.command(
			subjectFor.sipRingRpc(instanceId),
			"ring",
			request,
			SIP_RING_RPC.timeoutMs,
			sipRingResponseSchema,
		);
	}

	async answer(instanceId: string, request: SipAnswerRequest): Promise<SipAnswerResponse> {
		return await this.command(
			subjectFor.sipAnswerRpc(instanceId),
			"answer",
			request,
			SIP_ANSWER_RPC.timeoutMs,
			sipAnswerResponseSchema,
		);
	}

	async hangup(instanceId: string, request: SipHangupRequest): Promise<SipHangupResponse> {
		return await this.command(
			subjectFor.sipHangupRpc(instanceId),
			"hangup",
			request,
			SIP_HANGUP_RPC.timeoutMs,
			sipHangupResponseSchema,
		);
	}

	async reinvite(instanceId: string, request: SipReinviteRequest): Promise<SipReinviteResponse> {
		return await this.command(
			subjectFor.sipReinviteRpc(instanceId),
			"reinvite",
			request,
			SIP_REINVITE_RPC.timeoutMs,
			sipReinviteResponseSchema,
		);
	}

	async resolveTarget(request: SipResolveTargetRequest): Promise<SipResolveTargetResponse> {
		return await this.command(
			RPC_SUBJECTS.sipResolveTarget,
			"resolve-target",
			request,
			SIP_RESOLVE_TARGET_RPC.timeoutMs,
			sipResolveTargetResponseSchema,
		);
	}

	async originate(
		request: SipOriginateRequest,
		instanceId?: string,
	): Promise<SipOriginateResponse> {
		return await this.command(
			subjectFor.sipOriginateRpc(instanceId),
			"originate",
			request,
			SIP_ORIGINATE_RPC.timeoutMs,
			sipOriginateResponseSchema,
		);
	}

	// -------------------------------------------------------------------------------------------

	/**
	 * Issues one command and validates the reply against the contract.
	 *
	 * `safeParse` and not `parse`, and the asymmetry with the responders in this directory is the
	 * house rule rather than an inconsistency: a RESPONDER parses, because a request it cannot read is
	 * a `bad_request` it must answer by name; a CLIENT safe-parses, because a reply it cannot read
	 * must not become a throw on the call path when the caller has a perfectly good "this leg cannot
	 * be commanded" branch already. Validating at all is not ceremony — the responder is a different
	 * language compiled from the same Zod source, so the one failure this catches is the one nothing
	 * else can: a Go struct that drifted from the schema.
	 */
	private async command<TResponse extends { ok: boolean; legId: string }>(
		subject: string,
		operation: string,
		request: { readonly legId: string },
		timeoutMs: number,
		schema: { safeParse(value: unknown): { success: boolean; data?: unknown } },
	): Promise<TResponse> {
		const connection = this.connectionOf();
		if (connection === undefined || connection.isClosed()) {
			return this.refuse<TResponse>(
				subject,
				request.legId,
				"internal",
				"the engine has no NATS connection",
			);
		}

		let raw: unknown;
		const startedAt = performance.now();
		try {
			const reply = await connection.request(
				subject,
				this.encoder.encode(JSON.stringify(request)),
				{
					timeout: timeoutMs,
					// An empty header set, so the request carries the same shape `apps/sipd`'s own
					// requests do. NATS puts nothing of its own in a core request, which is the property
					// that makes the bytes on the wire exactly the contract.
					headers: headers(),
				},
			);
			raw = JSON.parse(this.decoder.decode(reply.data)) as unknown;
			this.latency.record(operation, performance.now() - startedAt);
		} catch (error) {
			this.latency.record(operation, performance.now() - startedAt, true);
			// `no responders available` when the edge holding this dialog has gone, a timeout when it is
			// wedged, a parse error when it answered something that is not JSON. See the class note for
			// why all three are one reason.
			return this.refuse<TResponse>(subject, request.legId, "internal", String(error));
		}

		const parsed = schema.safeParse(raw);
		if (!parsed.success) {
			return this.refuse<TResponse>(
				subject,
				request.legId,
				"internal",
				"the sip edge answered with something that is not the contract",
			);
		}
		const response = parsed.data as TResponse & {
			reason?: SipDialogRefusalReason;
			instanceId?: string;
		};
		if (!response.ok) {
			const details = {
				subject,
				legId: response.legId,
				reason: response.reason,
				instanceId: response.instanceId,
			};
			if (response.reason !== undefined && EXPECTED_REFUSAL_REASONS.has(response.reason)) {
				this.logger.debug(details, "the sip edge refused a dialog command");
			} else {
				this.logger.warn(details, "the sip edge refused a dialog command");
			}
		}
		return response;
	}

	/**
	 * The synthetic refusal, in the shape every response on this family shares.
	 *
	 * `legId` is echoed from the REQUEST rather than left empty, because the caller's whole reason for
	 * asking was that leg and a refusal it cannot attribute is a log line nobody can act on. There is
	 * no `instanceId`: the field means "who answered", and nobody did.
	 */
	private refuse<TResponse>(
		subject: string,
		legId: string,
		reason: SipDialogRefusalReason,
		error: string,
	): TResponse {
		this.logger.warn({ subject, legId, reason, err: error }, "could not reach the sip edge");
		return {
			ok: false,
			legId,
			reason,
			error: error.slice(0, 512),
		} as TResponse;
	}
}
