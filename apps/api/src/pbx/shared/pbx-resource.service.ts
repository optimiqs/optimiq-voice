import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import { runEffect } from "@optimiq-voice/effect-runtime";
import { toWireDiagnostic } from "./pbx.errors";
import type { PagedResult } from "./pagination";
import type { ListQuery } from "./pagination";
import type { PbxChildResource, PbxResource } from "./pbx-resource";
import type { PbxRepositoryRuntime } from "./pbx-runtime";
import type { WireDiagnostic } from "./pbx.errors";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * The shaping layer between the repository and the controllers.
 *
 * Effect never leaks above this class: `runEffect` is called exactly once per request path, which
 * is where a typed failure becomes its `toHttpException()` and anything else becomes an opaque
 * `err_…` 500. Controllers see Promises and plain objects.
 *
 * The organization id is read from the session here — once, in one place — and passed as the first
 * argument to every repository call. Repositories never infer a tenant (oikos §4), and no
 * controller is allowed to accept one from the client: an `organizationId` in a body or a query
 * string is a cross-tenant write waiting to be found.
 *
 * ## The response envelopes, which are a contract with `apps/web`
 *
 * ```jsonc
 * GET    …            -> { "data": [ … ], "total": 137, "page": 2, "limit": 20, "totalPages": 7 }
 * GET    …/:id        -> { "data": { … } }
 * POST   …            -> { "data": { … }, "warnings": [ … ] }   201
 * PATCH  …/:id        -> { "data": { … }, "warnings": [ … ] }
 * DELETE …/:id        -> { "data": { "id": "…" }, "warnings": [ … ] }
 * ```
 *
 * `warnings` is always present on a mutation, possibly empty. It carries the compiler's
 * `warning`-severity diagnostics with the offending form field already extracted from the
 * diagnostic's `path`, so P4 can attach "this ring group has no members" to the members list
 * without re-parsing anything. Errors never appear here — they are a 422 and the write was rolled
 * back.
 */
export interface MutationEnvelope<T> {
	readonly data: T;
	readonly warnings: readonly WireDiagnostic[];
}

export interface ItemEnvelope<T> {
	readonly data: T;
}

export abstract class PbxResourceService {
	protected constructor(
		protected readonly runtime: PbxRepositoryRuntime,
		protected readonly resource: PbxResource,
	) {}

	/** The active organization, or a 403 telling the caller to pick one. */
	protected organizationId(session: AppSession): string {
		return requireActiveOrganizationId(session);
	}

	async list(session: AppSession, query: ListQuery): Promise<PagedResult<Record<string, unknown>>> {
		const organizationId = this.organizationId(session);
		return await runEffect(this.runtime, (repository) =>
			repository.list(organizationId, this.resource, query),
		);
	}

	async get(session: AppSession, id: string): Promise<ItemEnvelope<Record<string, unknown>>> {
		const organizationId = this.organizationId(session);
		return {
			data: await runEffect(this.runtime, (repository) =>
				repository.get(organizationId, this.resource, id),
			),
		};
	}

	async create(
		session: AppSession,
		values: Record<string, unknown>,
	): Promise<MutationEnvelope<Record<string, unknown>>> {
		const organizationId = this.organizationId(session);
		const result = await runEffect(this.runtime, (repository) =>
			repository.create(organizationId, this.resource, values),
		);
		return { data: result.row, warnings: result.warnings.map(toWireDiagnostic) };
	}

	async update(
		session: AppSession,
		id: string,
		values: Record<string, unknown>,
	): Promise<MutationEnvelope<Record<string, unknown>>> {
		const organizationId = this.organizationId(session);
		const result = await runEffect(this.runtime, (repository) =>
			repository.update(organizationId, this.resource, id, values),
		);
		return { data: result.row, warnings: result.warnings.map(toWireDiagnostic) };
	}

	async remove(
		session: AppSession,
		id: string,
	): Promise<MutationEnvelope<{ readonly id: string }>> {
		const organizationId = this.organizationId(session);
		const result = await runEffect(this.runtime, (repository) =>
			repository.remove(organizationId, this.resource, id),
		);
		return { data: result.row, warnings: result.warnings.map(toWireDiagnostic) };
	}
}

/**
 * The same, for a collection owned by a parent (`/ivr-menus/:id/options`).
 *
 * Children are not paginated: an IVR menu with more than a screenful of options is a design
 * problem, not a paging problem, and the admin UI edits the whole ordered list at once. The parent
 * is proven to exist in the tenant before any child read or write, so a child endpoint under an
 * unknown parent is a 404 rather than an empty list.
 */
export abstract class PbxChildResourceService {
	protected constructor(
		protected readonly runtime: PbxRepositoryRuntime,
		protected readonly resource: PbxChildResource,
	) {}

	protected organizationId(session: AppSession): string {
		return requireActiveOrganizationId(session);
	}

	async list(
		session: AppSession,
		parentId: string,
	): Promise<{ readonly data: readonly Record<string, unknown>[] }> {
		const organizationId = this.organizationId(session);
		return {
			data: await runEffect(this.runtime, (repository) =>
				repository.listChildren(organizationId, this.resource, parentId),
			),
		};
	}

	async create(
		session: AppSession,
		parentId: string,
		values: Record<string, unknown>,
	): Promise<MutationEnvelope<Record<string, unknown>>> {
		const organizationId = this.organizationId(session);
		const result = await runEffect(this.runtime, (repository) =>
			repository.createChild(organizationId, this.resource, parentId, values),
		);
		return { data: result.row, warnings: result.warnings.map(toWireDiagnostic) };
	}

	async update(
		session: AppSession,
		parentId: string,
		id: string,
		values: Record<string, unknown>,
	): Promise<MutationEnvelope<Record<string, unknown>>> {
		const organizationId = this.organizationId(session);
		const result = await runEffect(this.runtime, (repository) =>
			repository.updateChild(organizationId, this.resource, parentId, id, values),
		);
		return { data: result.row, warnings: result.warnings.map(toWireDiagnostic) };
	}

	async remove(
		session: AppSession,
		parentId: string,
		id: string,
	): Promise<MutationEnvelope<{ readonly id: string }>> {
		const organizationId = this.organizationId(session);
		const result = await runEffect(this.runtime, (repository) =>
			repository.removeChild(organizationId, this.resource, parentId, id),
		);
		return { data: result.row, warnings: result.warnings.map(toWireDiagnostic) };
	}
}
