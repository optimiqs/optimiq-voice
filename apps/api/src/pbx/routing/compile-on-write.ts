import {
	affectsRouting,
	type Diagnostic,
	isArtifactFresh,
	type RoutingArtifact,
	routingCacheKey,
	tryCompileRoutingArtifact,
} from "@optimiq-voice/routing";
import { RoutingCompileFailure } from "../shared/pbx.errors";
import { loadOrgRoutingSnapshot } from "./snapshot-loader";
import type { PbxDatabaseTransaction } from "@optimiq-voice/pbx-db";

/**
 * Compile-on-write.
 *
 * ## The transaction design, and why the compile is inside it
 *
 * Every mutation to a table `affectsRouting()` returns true for runs as:
 *
 * ```
 * begin
 *   set local role pbx_tenant_tls
 *   select set_config('pbx_tenant_tls.organization_id', $org, true)
 *   ── guards ──────────────────────────────────────────────────────────
 *   destination trio shape + a real existence check per trio
 *   reverse-reference scan (deletes only)
 *   ── the write ───────────────────────────────────────────────────────
 *   insert / update / delete
 *   ── compile-on-write ────────────────────────────────────────────────
 *   load the complete snapshot (19 reads, unfiltered, unjoined)
 *   tryCompileRoutingArtifact(snapshot, { compiledAt })
 *     errors   -> throw RoutingCompileFailure  -> ROLLBACK -> 422
 *     no error -> carry the artifact + warnings out
 * commit
 * ── after commit ────────────────────────────────────────────────────────
 * publish the artifact to the `routing-cache` KV bucket (best effort)
 * ```
 *
 * Three properties fall out of that ordering, and each of them is the reason for it:
 *
 * **The snapshot the compiler sees includes the uncommitted write.** It is read on the same
 * connection inside the same transaction, so the compile answers "would this configuration be
 * sound *after* this change?" — which is the only question worth asking on a write path. Compiling
 * before the write would validate the previous state; compiling after the commit would discover
 * the problem when it is already persisted.
 *
 * **An unsound artifact cannot be saved.** The failure is raised *inside* the transaction, so
 * Postgres rolls the row change back. Without that, a save that produces a dangling destination
 * would leave the tenant's stored configuration and the configuration the engine can execute
 * permanently out of step, and the next, unrelated save would fail on somebody else's mistake.
 * This is why the compile is not deferred to a background job.
 *
 * **The cache is written only after the commit succeeds.** Publishing from inside the transaction
 * would put an artifact for a rolled-back state into the bucket, where the engine would resolve
 * calls against it. See `routing-cache.publisher.ts` for the other half of that argument.
 *
 * ## Warnings never block
 *
 * `packages/routing` draws the line explicitly: an *error* means the artifact would not be sound;
 * a *warning* means it is sound but probably not what was meant. An empty ring group is the normal
 * state of a half-built admin UI — you create the group, then add members — so refusing that save
 * would make the product unusable. Warnings ride out in the response envelope instead, and P4
 * renders them inline.
 */

/** What a successful compile-on-write hands back to the caller. */
export interface CompiledWrite {
	readonly artifact: RoutingArtifact;
	readonly cacheKey: string;
	readonly warnings: readonly Diagnostic[];
	/** False when the recompile produced the same `snapshotHash` as the artifact handed in. */
	readonly changed: boolean;
}

/**
 * Compiles the organization's current (in-transaction) configuration.
 *
 * @throws {RoutingCompileFailure} when the configuration contains errors — which rolls the
 *   enclosing transaction back, by design.
 */
export async function compileOnWrite(
	transaction: PbxDatabaseTransaction,
	organizationId: string,
	options: { readonly previous?: RoutingArtifact; readonly compiledAt?: string } = {},
): Promise<CompiledWrite> {
	const snapshot = await loadOrgRoutingSnapshot(transaction, organizationId);
	const result = tryCompileRoutingArtifact(snapshot, {
		compiledAt: options.compiledAt ?? new Date().toISOString(),
	});

	if (!result.ok) {
		throw new RoutingCompileFailure({ organizationId, diagnostics: result.diagnostics });
	}

	// `isArtifactFresh` compares content hashes, so a write that touched a routing table without
	// changing anything routing reads (a label edit on an already-identical row, a re-save of the
	// same form) skips the KV round trip entirely. `compiledAt` is the only non-derived field, so
	// this is a safe short-circuit rather than a heuristic.
	const changed = options.previous === undefined || !isArtifactFresh(options.previous, snapshot);

	return {
		artifact: result.artifact,
		cacheKey: routingCacheKey(organizationId),
		warnings: result.diagnostics.filter((diagnostic) => diagnostic.severity === "warning"),
		changed,
	};
}

/**
 * Whether a mutation to this physical table needs a recompile.
 *
 * A thin pass-through so call sites read as intent rather than as an import from a package they
 * otherwise do not touch, and so the one place that decides this is greppable. `affectsRouting`
 * is the cheap gate: a voicemail message, a CDR row or a device edit must not evict a hot
 * artifact, and `packages/routing` owns the list of what does.
 */
export function requiresRecompile(tableName: string): boolean {
	return affectsRouting(tableName);
}
