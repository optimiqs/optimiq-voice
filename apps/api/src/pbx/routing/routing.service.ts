import { Inject, Injectable } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import { runEffect } from "@optimiq-voice/effect-runtime";
import { ROUTING_CACHE_KV } from "@optimiq-voice/events/streams";
import { getLogger } from "@optimiq-voice/logging";
import {
	isRoutingContext,
	parseRoutingArtifact,
	type PlanNode,
	planNode,
	type ResolvedRoute,
	resolveInbound,
	resolveInternal,
	resolveOutbound,
	type RoutingArtifact,
	type RoutingContext,
	routingCacheKey,
} from "@optimiq-voice/routing";
import { toWireDiagnostic } from "../shared/pbx.errors";
import { PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import { RoutingCachePublisher } from "./routing-cache.publisher";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";
import type { WireDiagnostic } from "../shared/pbx.errors";
import type { AppSession } from "@optimiq-voice/auth";
import type { RoutingResolveRequest, RoutingResolveResponse } from "@optimiq-voice/events/schemas";

const logger = getLogger("api.pbx");

/**
 * The TTL the engine should apply to a cached artifact, taken from the bucket definition rather
 * than restated: the bucket already carries `ttlMs` as a backstop, and two numbers that mean the
 * same thing are two numbers that will disagree.
 */
const ROUTING_CACHE_TTL_MS = ROUTING_CACHE_KV.ttlMs;

/**
 * The routing surface: compile-on-demand, the `rpc.routing.v1.resolve` responder, and the
 * "what happens if someone calls this number?" simulator.
 */
@Injectable()
export class RoutingService {
	constructor(
		@Inject(PBX_EFFECT_RUNTIME) private readonly runtime: PbxRepositoryRuntime,
		@Inject(RoutingCachePublisher) private readonly publisher: RoutingCachePublisher,
	) {}

	/**
	 * Recompiles an organization and republishes the artifact.
	 *
	 * The manual counterpart to compile-on-write, for a tenant whose cache was evicted by hand or
	 * whose artifact predates an artifact-version bump. It returns the hash rather than the whole
	 * artifact: a compiled artifact for a large tenant is megabytes, and nothing in the admin UI
	 * needs it — the engine gets it over KV.
	 */
	async compile(session: AppSession): Promise<{
		readonly organizationId: string;
		readonly snapshotHash: string;
		readonly compiledAt: string;
		readonly cacheKey: string;
		readonly published: boolean;
		readonly warnings: readonly WireDiagnostic[];
	}> {
		const organizationId = requireActiveOrganizationId(session);
		const compiled = await runEffect(this.runtime, (repository) =>
			repository.compile(organizationId),
		);
		const published = await this.publisher.publish(compiled.cacheKey, compiled.artifact);
		return {
			organizationId,
			snapshotHash: compiled.artifact.snapshotHash,
			compiledAt: compiled.artifact.compiledAt,
			cacheKey: compiled.cacheKey,
			published,
			warnings: compiled.warnings.map(toWireDiagnostic),
		};
	}

	/**
	 * Answers `rpc.routing.v1.resolve`.
	 *
	 * The engine calls this on a `routing-cache` **miss**, so the fast path is not "read the KV" —
	 * it is "compile and hand the artifact back so the engine can populate the cache itself". The
	 * KV is still consulted first because a miss on the engine's side and a miss on ours are not
	 * the same event (a second engine instance may have populated it a millisecond ago), and a hit
	 * saves nineteen reads and a compile on the call path.
	 *
	 * A cached entry whose `artifactVersion` this release does not understand is discarded rather
	 * than walked best-effort: `parseRoutingArtifact` throws, and the recompile below replaces it.
	 * That is the version contract `packages/routing` states, and half-reading an artifact from a
	 * future release is how a call ends up somewhere nobody configured.
	 */
	async resolve(request: RoutingResolveRequest): Promise<RoutingResolveResponse> {
		const cacheKey = routingCacheKey(request.orgId);
		const at = request.at === undefined ? new Date() : new Date(request.at);

		let artifact = await this.readCachedArtifact(cacheKey);
		if (artifact === undefined) {
			const compiled = await runEffect(this.runtime, (repository) =>
				repository.compile(request.orgId),
			);
			artifact = compiled.artifact;
			// Populate the cache ourselves too: the engine will also write it, and a KV put is
			// idempotent, but a second engine instance resolving the same org one moment later
			// should not have to pay for another compile.
			await this.publisher.publish(cacheKey, artifact);
		}

		const context = this.routingContextOf(request);
		if (context === undefined) {
			return {
				matched: false,
				cacheKey,
				artifact,
				ttlMs: ROUTING_CACHE_TTL_MS,
				reason: `Unknown routing context "${request.routingContext}".`,
			};
		}

		const route = this.runResolver(artifact, context, request, at);
		const entry = route.plan === undefined ? undefined : planNode(artifact, route.plan.entryNodeId);

		return {
			matched: route.matched,
			...destinationOf(entry),
			routingContext: route.context,
			artifact,
			cacheKey,
			ttlMs: ROUTING_CACHE_TTL_MS,
			...(route.reason === undefined ? {} : { reason: route.reason.slice(0, 256) }),
		};
	}

	/**
	 * "What happens if someone calls this number?"
	 *
	 * The admin-facing counterpart of {@link resolve}: same resolvers, same explicit instant, but
	 * it compiles from the database rather than trusting the cache, and it returns the compiler's
	 * and the resolver's diagnostics instead of the artifact. Reading the cache here would mean the
	 * tool could disagree with the configuration on screen, which is the one thing a "why does this
	 * DID go there?" answer must never do.
	 */
	async simulate(
		session: AppSession,
		request: {
			readonly routingContext: RoutingContext;
			readonly destinationNumber: string;
			readonly callerNumber?: string;
			readonly callerName?: string;
			readonly at?: string;
		},
	): Promise<{
		readonly matched: boolean;
		readonly routingContext: RoutingContext;
		readonly entryNodeId?: string;
		readonly destinationType?: string;
		readonly destinationRef?: string;
		readonly matchedRuleId?: string;
		readonly matchedRuleName?: string;
		readonly dialedNumber?: string;
		readonly reason?: string;
		readonly diagnostics: readonly WireDiagnostic[];
	}> {
		const organizationId = requireActiveOrganizationId(session);
		const compiled = await runEffect(this.runtime, (repository) =>
			repository.compile(organizationId),
		);
		const at = request.at === undefined ? new Date() : new Date(request.at);
		const route = this.runResolver(
			compiled.artifact,
			request.routingContext,
			{
				orgId: organizationId,
				direction: request.routingContext === "inbound" ? "inbound" : "outbound",
				destinationNumber: request.destinationNumber,
				routingContext: request.routingContext,
				...(request.callerNumber === undefined ? {} : { callerNumber: request.callerNumber }),
				...(request.callerName === undefined ? {} : { callerName: request.callerName }),
			},
			at,
		);
		const entry =
			route.plan === undefined ? undefined : planNode(compiled.artifact, route.plan.entryNodeId);

		return {
			matched: route.matched,
			routingContext: route.context,
			...(route.plan === undefined ? {} : { entryNodeId: route.plan.entryNodeId }),
			...destinationOf(entry),
			...(route.matchedRuleId === undefined ? {} : { matchedRuleId: route.matchedRuleId }),
			...(route.matchedRuleName === undefined ? {} : { matchedRuleName: route.matchedRuleName }),
			...(route.dialedNumber === undefined ? {} : { dialedNumber: route.dialedNumber }),
			...(route.reason === undefined ? {} : { reason: route.reason }),
			// The compiler's warnings and the resolver's decisions, in one list: "this ring group is
			// empty" and "the time-condition gate was closed" are the same kind of answer to the same
			// kind of question.
			diagnostics: [...compiled.warnings, ...route.diagnostics].map(toWireDiagnostic),
		};
	}

	private async readCachedArtifact(cacheKey: string): Promise<RoutingArtifact | undefined> {
		const cached = await this.publisher.read(cacheKey);
		if (cached === undefined) {
			return undefined;
		}
		try {
			return parseRoutingArtifact(cached);
		} catch (error) {
			logger.warn({ cacheKey, error }, "discarding an unreadable cached routing artifact");
			return undefined;
		}
	}

	private routingContextOf(request: RoutingResolveRequest): RoutingContext | undefined {
		return isRoutingContext(request.routingContext) ? request.routingContext : undefined;
	}

	private runResolver(
		artifact: RoutingArtifact,
		context: RoutingContext,
		request: RoutingResolveRequest,
		now: Date,
	): ResolvedRoute {
		switch (context) {
			case "inbound": {
				return resolveInbound(artifact, {
					did: request.destinationNumber,
					...(request.callerNumber === undefined ? {} : { callerNumber: request.callerNumber }),
					...(request.callerName === undefined ? {} : { callerName: request.callerName }),
					now,
				});
			}
			case "internal": {
				return resolveInternal(artifact, {
					from: request.callerNumber ?? "",
					dialed: request.destinationNumber,
					now,
				});
			}
			default: {
				return resolveOutbound(artifact, {
					from: request.callerNumber ?? "",
					dialed: request.destinationNumber,
					now,
				});
			}
		}
	}
}

/**
 * Projects the resolved entry node onto the rpc contract's `destinationType` / `destinationRef`.
 *
 * The plan-node kind IS the destination type, verbatim. `packages/events`'
 * `destinationTypeSchema` accepts kebab-case as of `de8c4a30d`, so `ring-group` and
 * `time-condition` cross the wire as the compiler names them — one vocabulary from the database
 * column through the compiler to the engine, with no translation table to drift.
 *
 * `destinationRef` is only set for kinds that are backed by a row, because the field is
 * `z.uuid()`: an `external` node's "ref" is an E.164 string and would fail validation. The type is
 * still reported for those, so the engine can tell "went to an external number" from "hung up".
 */
export function destinationOf(node: PlanNode | undefined): {
	destinationType?: string;
	destinationRef?: string;
} {
	if (node === undefined) {
		return {};
	}
	const destinationType = node.kind;
	switch (node.kind) {
		case "extension": {
			return { destinationType, destinationRef: node.extensionId };
		}
		case "ring-group": {
			return { destinationType, destinationRef: node.ringGroupId };
		}
		case "ivr-menu": {
			return { destinationType, destinationRef: node.ivrMenuId };
		}
		case "queue": {
			return { destinationType, destinationRef: node.queueId };
		}
		case "voicemail": {
			return { destinationType, destinationRef: node.voicemailBoxId };
		}
		case "conference": {
			return { destinationType, destinationRef: node.conferenceId };
		}
		case "park": {
			return { destinationType, destinationRef: node.parkLotId };
		}
		// A page is row-backed like the rest, and it is also terminal — the announcement ends where
		// it started. That makes no difference here: this function reports what the call REACHED, and
		// "reached paging group X" is exactly as reportable as "reached queue Y". The kind travels
		// verbatim as `paging`, which is what the compiler named the node.
		case "paging": {
			return { destinationType, destinationRef: node.pagingGroupId };
		}
		case "time-condition": {
			return { destinationType, destinationRef: node.timeConditionId };
		}
		case "feature-code": {
			return { destinationType, destinationRef: node.featureCodeId };
		}
		case "trunk-dial": {
			return { destinationType, destinationRef: node.outboundRouteId };
		}
		default: {
			// `external`, `application`, `playback`, `hangup` — value-backed or terminal. The type
			// still tells the engine what happened; there is no row to name.
			return { destinationType };
		}
	}
}
