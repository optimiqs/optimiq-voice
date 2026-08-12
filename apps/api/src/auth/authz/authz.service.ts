import { Inject, Injectable } from "@nestjs/common";
import { hasPermission, isPermission } from "@optimiq-voice/auth";
import { and, eq, extension, extensionUser } from "@optimiq-voice/pbx-db";
import { PBX_DATABASE } from "../../pbx/shared/pbx.tokens";
import { AUTH_REPOSITORY } from "../auth.tokens";
import { resolveRolePermissions } from "../role-permissions";
import type { AuthRepository } from "../auth.repository";
import type { Permission } from "@optimiq-voice/auth";
import type { AuthzCheckRequest, AuthzCheckResponse } from "@optimiq-voice/events/schemas";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * `rpc.authz.v1.check` — "may this subject do these things in this organization?"
 *
 * The contract has been declared since the first wave of `packages/events` and nothing has ever
 * answered it. What made it worth building now is `*0` supervision: a supervisor picks up a desk
 * phone, dials a colleague's extension, and the engine has to decide whether to attach a media tap
 * to somebody else's live conversation. There is no session on a handset and the engine holds no
 * database, so the decision cannot be made where the call is — it has to be asked for.
 *
 * ## Two subject kinds are resolved, two are refused, and none of the four throws
 *
 * `user` is the ordinary one: a membership role in `orgId`, expanded through the same
 * {@link resolveRolePermissions} every HTTP request goes through, so a permission an admin holds on
 * a screen is the same permission they hold on a phone. There is deliberately no second expansion
 * path — a broker principal and an HTTP principal that disagreed about what `manager` means would
 * be a bug nobody could reproduce from either side.
 *
 * `extension` is the one this subject type was added for, and the whole of it is in the contract's
 * own note: an extension NUMBER is authentication of exactly the strength of the desk the phone sits
 * on, and it is not authorization. It is a CLAIM. So it is resolved, in the tenant's own scope,
 * through three hops that must all land — number → extension row → primary `extension_user` link →
 * that user's membership role — and any hop that misses is a denial rather than a shortcut.
 *
 * `api-key` and `service` are answered `allowed: false` with a reason that says so plainly. See
 * {@link AuthzService.check} for why an honest refusal beats a throw here.
 *
 * ## TWO database handles, because the tables are in two databases
 *
 * `extension_user.userId` is a plain uuid with **no foreign key**: the better-auth tables live in a
 * different database entirely and `packages/pbx-db/src/schema/extensions-schema.ts` records that
 * cross-database references are forbidden. There is therefore no join to write, and no query that
 * could answer this in one round trip however it were phrased. The extension hop runs against
 * `PBX_DATABASE` inside `withTenantScope(orgId)` — RLS is the tenant filter, as everywhere else in
 * that area — and the membership hop runs against the auth adapter with `organizationId` passed
 * explicitly, because that database has no RLS and the scope has to be in the predicate.
 *
 * The consequence worth stating: a `userId` on an extension link can point at a user that no longer
 * exists. Integrity across the two databases is maintained by the API on a `user.deleted` handler,
 * which is a repair, not a constraint — so the second hop returning nothing is an ordinary state to
 * answer, not an invariant violation to log loudly.
 */
@Injectable()
export class AuthzService {
	constructor(
		@Inject(AUTH_REPOSITORY) private readonly repository: AuthRepository,
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
	) {}

	/**
	 * Answers one check.
	 *
	 * @throws never in the paths it owns. The controller still wraps it — see its header.
	 */
	async check(request: AuthzCheckRequest): Promise<AuthzCheckResponse> {
		const resolved = await this.resolveGrants(request);
		if (resolved.kind === "unresolved") {
			return denyAll(request.permissions, resolved.reason);
		}
		return partition(request.permissions, resolved.permissions);
	}

	/**
	 * The permission set the subject actually holds, or why there is not one.
	 *
	 * Split out from {@link check} so the partition below is a pure function of two lists: whether a
	 * request is allowed and how the caller was identified are two questions, and mixing them is how
	 * an authorization decision ends up depending on which lookup happened to be slow.
	 */
	private async resolveGrants(request: AuthzCheckRequest): Promise<ResolvedGrants> {
		switch (request.subject.type) {
			case "user": {
				return await this.grantsForUser(request.subject.id, request.orgId);
			}
			case "extension": {
				return await this.grantsForExtension(request.subject.id, request.orgId);
			}
			default: {
				/*
				 * `api-key` and `service`, answered rather than pretended.
				 *
				 * Neither has a resolver yet and neither is hard to build — an API key's permissions are
				 * on the key row, and a service principal's are whatever the deployment decides — but
				 * building one on the way past would mean inventing the policy for a caller that does not
				 * exist, and this is the last subject on the platform where a plausible-looking guess is
				 * acceptable.
				 *
				 * WHY NOT THROW. A throw on a Nest `@MessagePattern` becomes no reply, and no reply is a
				 * broker timeout at the requester. A caller that timed out and a caller that was denied
				 * look identical from the far side — both got nothing — which is precisely the failure
				 * this subject exists to prevent: the whole point of an authorization check is that a
				 * denial is a DECISION, made here, attributable, and distinguishable from the network
				 * being unwell. An engine that treats "no answer" and "no" as the same thing is an engine
				 * that will eventually treat one broker hiccup as an outage of supervision for a whole
				 * tenant; an engine that treats them as different can log "denied: no resolver for
				 * api-key" and somebody can act on it.
				 */
				return {
					kind: "unresolved",
					reason: `subject type "${request.subject.type}" has no resolver in this release; nothing is granted to it`,
				};
			}
		}
	}

	/** A member of the organization, through the membership row rather than through a session. */
	private async grantsForUser(userId: string, organizationId: string): Promise<ResolvedGrants> {
		const membership = await this.repository.findMembership(userId, organizationId);
		if (!membership) {
			// Not "unknown user" — this responder cannot tell that apart from "known user, not a member
			// here", and it must not try: the two are the same answer, and distinguishing them over a
			// broker subject any service can publish to would make this a membership oracle.
			return { kind: "unresolved", reason: "the subject is not a member of this organization" };
		}
		return { kind: "resolved", permissions: resolveRolePermissions(membership.role) };
	}

	/**
	 * A REGISTERED EXTENSION, resolved to the user behind it.
	 *
	 * Three hops, and the interesting part is that hop two and hop three are in different databases.
	 * See the class header.
	 */
	private async grantsForExtension(
		extensionNumber: string,
		organizationId: string,
	): Promise<ResolvedGrants> {
		const link = await this.resolvePrimaryLink(organizationId, extensionNumber);
		if (link === undefined) {
			/*
			 * One refusal for four different misses — no such number, a disabled extension, an extension
			 * belonging to another tenant (RLS answers that read with nothing, so it arrives here
			 * indistinguishable from a typo), and an extension nobody is linked to as `primary`.
			 *
			 * Deliberately one, on the argument `extension-feature.service.ts` already records: telling
			 * them apart is a way to enumerate a tenant's extensions from a handset, and the caller
			 * cannot act on the difference anyway. `reason` is for the support log.
			 */
			return {
				kind: "unresolved",
				reason: `no enabled extension ${extensionNumber} with a primary user in this organization`,
			};
		}
		/*
		 * Hop three, in the OTHER database. A `userId` that resolves to no membership is an ordinary
		 * state rather than corruption: the link column has no foreign key to enforce it, because it
		 * cannot have one.
		 */
		return await this.grantsForUser(link.userId, organizationId);
	}

	/**
	 * The primary user linked to an enabled extension of this organization, or `undefined`.
	 *
	 * Two selects inside ONE `withTenantScope`, rather than two scopes: they are halves of a single
	 * question, and running them in separate tenant transactions would let the extension be deleted
	 * between them and turn an authorization answer into a race.
	 *
	 * `enabled` is part of the question rather than a field to check afterwards, on the same terms
	 * `extension-feature.service.ts` states: a disabled extension is not in the compiled artifact, so
	 * no call can be arriving from it, and a request claiming one is a request that should be denied
	 * rather than a request to be resolved.
	 *
	 * `role: "primary"` and not `shared` or `delegate`. A shared line is a phone several people can
	 * answer from — a hot desk, a front desk — and a permission set drawn from whichever of them the
	 * database returned first is not an identity, it is a coin toss. The audit row that has to name
	 * one person is the reason (see `calls.supervise` in `packages/auth`), and a shared line cannot
	 * produce one. `limit(1)` is still correct: the unique index on
	 * `(organization_id, extension_id, user_id)` does not stop two users being `primary` on one
	 * extension, which is a data problem this read must not turn into a crash.
	 */
	private async resolvePrimaryLink(
		organizationId: string,
		extensionNumber: string,
	): Promise<{ readonly userId: string } | undefined> {
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const extensions = await transaction
				.select({ id: extension.id, enabled: extension.enabled })
				.from(extension)
				.where(eq(extension.number, extensionNumber))
				.limit(1);
			const row = extensions[0];
			if (row === undefined || !row.enabled) {
				return undefined;
			}

			const links = await transaction
				.select({ userId: extensionUser.userId })
				.from(extensionUser)
				.where(and(eq(extensionUser.extensionId, row.id), eq(extensionUser.role, "primary")))
				.limit(1);
			return links[0];
		});
	}
}

type ResolvedGrants =
	| { readonly kind: "resolved"; readonly permissions: readonly Permission[] }
	| { readonly kind: "unresolved"; readonly reason: string };

/**
 * Splits the request into what the subject holds and what it does not.
 *
 * `hasPermission` and not a `Set.has`, because an unscoped grant covers its scopes: a manager
 * holding `voicemail.listen` satisfies a check for `voicemail.listen.own`, and a responder that
 * compared strings would deny it. That rule lives in `packages/auth` and is the same one the HTTP
 * guard applies, which is the property worth preserving — one expansion, one matcher, one answer.
 *
 * A permission string the registry does not know goes straight into `missing`. It cannot be
 * `granted` (nothing can hold it) and it must not throw: the request schema accepts any dotted
 * kebab-case string, so an engine on a newer release asking about a permission this API has never
 * heard of is version skew, which is a state to answer rather than an impossibility.
 */
export function partition(
	requested: readonly string[],
	granted: readonly Permission[],
): AuthzCheckResponse {
	const held = new Set<string>(granted);
	const allowedPermissions: string[] = [];
	const missing: string[] = [];
	let unknown = 0;

	for (const permission of requested) {
		if (!isPermission(permission)) {
			unknown += 1;
			missing.push(permission);
			continue;
		}
		if (hasPermission(held, permission)) {
			allowedPermissions.push(permission);
		} else {
			missing.push(permission);
		}
	}

	// `allowed` is EVERY requested permission and not any of them. A partial answer would be read as
	// a yes by the first caller that only checked the boolean, and on this subject the first caller
	// is the one deciding whether to attach a tap.
	const allowed = missing.length === 0;
	return {
		allowed,
		granted: allowedPermissions,
		missing,
		...(allowed
			? {}
			: {
					reason: reasonFor(missing, unknown),
				}),
	};
}

function reasonFor(missing: readonly string[], unknown: number): string {
	const listed = missing.join(", ");
	const suffix =
		unknown === 0
			? ""
			: ` (${unknown} of which ${unknown === 1 ? "is" : "are"} not in this release's permission registry)`;
	return `not granted: ${listed}${suffix}`.slice(0, 256);
}

/**
 * A denial that names nothing as granted.
 *
 * Every unresolved subject ends here, and the shape matters: `missing` is the WHOLE request rather
 * than an empty list, because a caller that intersects `missing` against what it asked for should
 * find everything it asked for. An empty `missing` beside `allowed: false` is the reading that
 * produces a "no permissions were missing, so it must have been a glitch, retry" loop.
 */
export function denyAll(requested: readonly string[], reason: string): AuthzCheckResponse {
	return { allowed: false, granted: [], missing: [...requested], reason: reason.slice(0, 256) };
}
