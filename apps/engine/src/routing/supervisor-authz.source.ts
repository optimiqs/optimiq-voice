import { Inject, Injectable } from "@nestjs/common";
import { firstValueFrom, timeout } from "rxjs";
import { AUTHZ_CHECK_RPC, authzCheckResponseSchema } from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { ROUTING_RPC_CLIENT } from "../nats/nats.tokens";
import type {
	SupervisorAuthzPort,
	SupervisorAuthzRequest,
	SupervisorDecision,
} from "./plan-walker";
import type { ClientProxy } from "@nestjs/microservices";
import type { AuthzCheckRequest } from "@optimiq-voice/events";

/**
 * `*0` — is the handset that just dialled this allowed to listen to somebody else's call?
 *
 * ## Why the engine asks rather than decides
 *
 * Every other gate the walker applies is compiled into the artifact: the toll class, the pickup
 * group, the outbound kill switch. Supervision is deliberately not, and the reason is not
 * convenience. Those gates are properties of the CALL — of an extension's own configuration — and
 * they change when a tenant edits telephony. This one is a property of the PERSON: it is the same
 * `calls.supervise` grant that gates the same act from the web console, held by a role a member is
 * assigned in the auth database that `packages/routing` has never read and should not start to.
 *
 * Compiling a supervisor flag onto an extension node would make the artifact a second, staler copy
 * of the permission model, and the day the two disagreed the telephony copy would be the one
 * nobody was auditing. So the engine asks the process that owns the answer, over the contract that
 * has existed for exactly this since the beginning and had no caller until now.
 *
 * ## The identity is the extension, and it is a CLAIM
 *
 * `rpc.authz.v1.check` takes a subject, and the engine has no user id — it has a leg whose caller
 * id the SIP edge authenticated. So the subject is `{ type: "extension", id: <number> }` and the
 * responder resolves it inside the tenant's own scope: number → extension row → primary
 * `extension_user` link → member role → permissions. That is the same posture
 * `rpc.pbx.v1.extension-feature` takes with its own `extensionNumber`, and for the same reason —
 * this end can send the number plainly precisely because the other end does not trust it.
 *
 * ## Every failure is a DENIAL, and that is the whole point of this file
 *
 * A timeout, an absent responder, a malformed reply and an explicit `allowed: false` all collapse
 * to the same answer here: no. This is the one port in the engine that must fail CLOSED, and it is
 * worth saying why it is different from its neighbours. `rpc.pbx.v1.extension-feature` failing open
 * would be absurd — nothing was written — and `rpc.pbx.v1.last-caller` failing open is simply "no
 * number to return". Failing open here would mean anyone who can dial `*0` from any desk listens to
 * any conversation in the building for as long as the broker is unwell, and the people on the call
 * would never know it happened. So the catch below does not attempt to distinguish "denied" from
 * "could not ask": the caller hears the same announcement either way, and `reason` carries the
 * difference to the log where an operator can act on it.
 */
@Injectable()
export class SupervisorAuthzRpcPort implements SupervisorAuthzPort {
	private readonly logger = getLogger("engine.supervision");
	private calls = 0;
	private denials = 0;

	constructor(@Inject(ROUTING_RPC_CLIENT) private readonly client: ClientProxy) {}

	/** Read by the specs and available to a health surface, on the same terms as its neighbours. */
	get stats(): { readonly calls: number; readonly denials: number } {
		return { calls: this.calls, denials: this.denials };
	}

	async authorize(request: SupervisorAuthzRequest): Promise<SupervisorDecision> {
		this.calls += 1;
		const payload: AuthzCheckRequest = {
			orgId: request.organizationId,
			subject: { type: "extension", id: request.extensionNumber },
			permissions: [SUPERVISE_PERMISSION],
			// The resource narrows the audit line on the responder's side: this is not a blanket
			// "may supervise", it is "may supervise a call at this extension". The responder is free
			// to ignore it today — it has no per-extension scope yet — and carrying it means the day
			// `calls.supervise.team` exists, the request already says what it needs to.
			resource: { type: "extension", id: request.targetExtension },
		};

		try {
			// Parsed, not trusted, for the reason every RPC client here parses: the responder is
			// another process on another release, and a reply whose shape drifted must become a
			// denial rather than an approval assembled from fields that were not there.
			const reply = authzCheckResponseSchema.parse(
				await firstValueFrom(
					this.client
						.send(AUTHZ_CHECK_RPC.subject, payload)
						.pipe(timeout(AUTHZ_CHECK_RPC.timeoutMs)),
				),
			);
			if (!reply.allowed) {
				this.denials += 1;
				this.logger.info(
					{
						organizationId: request.organizationId,
						extensionNumber: request.extensionNumber,
						targetExtension: request.targetExtension,
						missing: reply.missing,
					},
					"a handset dialled *0 without the supervise grant",
				);
				return {
					allowed: false,
					reason: reply.reason ?? `missing ${reply.missing.join(", ") || SUPERVISE_PERMISSION}`,
				};
			}
			return { allowed: true };
		} catch (error) {
			this.denials += 1;
			this.logger.warn(
				{
					organizationId: request.organizationId,
					extensionNumber: request.extensionNumber,
					targetExtension: request.targetExtension,
					err: String(error),
				},
				"rpc.authz.v1.check did not answer; the supervision request is DENIED rather than allowed",
			);
			return { allowed: false, reason: "the authorization service did not answer" };
		}
	}
}

/**
 * The grant `*0` requires, spelled here rather than imported from `packages/auth`.
 *
 * The engine does not depend on the auth package and should not start to for one string: it holds
 * no session, resolves no role and would gain a dependency on the entire permission model in order
 * to name one member of it. The contract's own regex (`<resource>.<action>`) is what the wire
 * validates, and the responder is the side that must recognise the string — an engine that sent an
 * unknown permission gets `allowed: false` with it listed in `missing`, which is a denial and a
 * legible log line rather than a silent pass.
 */
const SUPERVISE_PERMISSION = "calls.supervise";
