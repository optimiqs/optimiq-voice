import { Inject, Injectable, Optional } from "@nestjs/common";
import { hasPermission, requireActiveOrganizationId } from "@optimiq-voice/auth";
import { getLogger } from "@optimiq-voice/logging";
import {
	CdrInvalidCursorException,
	CdrNotFoundException,
	CdrRangeTooWideException,
	CdrSelfScopeUnavailableException,
} from "../shared/cdr.errors";
import { CDR_DATABASE } from "../shared/cdr.tokens";
import { readAgentStats } from "./agent-stats";
import { readCallVolume } from "./call-volume";
import { CdrCursorError, nextCursorFrom } from "./cdr-cursor";
import { hasAnyParty, ownPartyMatcher } from "./cdr-self-scope";
import { MAX_RANGE_DAYS, rangeDays, resolveTimeRange } from "./cdr.dto";
import {
	getCallLeg,
	listCallLegs,
	listCallLegsForCall,
	listRecordingsForLegs,
} from "./cdr.repository";
import { readQueueStats } from "./queue-stats";
import { CDR_QUEUE_SURVEY } from "./queue-survey.port";
import { CDR_SELF_PARTIES } from "./self-parties";
import type { AgentStatsRow } from "./agent-stats";
import type { CallVolumeDestinationRow, CallVolumeRow } from "./call-volume";
import type { OwnedParties } from "./cdr-self-scope";
import type {
	AgentStatsQueryDto,
	CallVolumeQueryDto,
	CdrCallQuery,
	CdrLegQuery,
	CdrListQuery,
	QueueStatsQueryDto,
	ResolvedTimeRange,
} from "./cdr.dto";
import type { CallLegDetailRow, CallLegListRow, RecordingListRow } from "./cdr.repository";
import type { QueueStatsRow } from "./queue-stats";
import type {
	QueueSurveyCallAnswer,
	QueueSurveySource,
	QueueSurveySummary,
} from "./queue-survey.port";
import type { CdrSelfParties } from "./self-parties";
import type { AppSession } from "@optimiq-voice/auth";
import type { CdrDatabaseClient } from "@optimiq-voice/cdr-db";

/**
 * The shaping layer between the reporting repository and the controllers.
 *
 * Same division as the PBX area's `PbxResourceService`: the organization id is read from the
 * session here — once, in one place — and no controller is allowed to accept one from the client.
 * An `organizationId` in a query string is a cross-tenant read waiting to be found.
 *
 * ## The response envelopes, which are a contract with `apps/web`
 *
 * ```jsonc
 * GET /api/v1/cdr            -> { "data": [ … ], "nextCursor": "…"|null, "limit": 25,
 *                                 "range": { "from": "…", "to": "…" } }
 * GET /api/v1/cdr/:id        -> { "data": { …leg…, "recordings": [ … ] } }
 * GET /api/v1/cdr/calls/:id  -> { "data": { "callId": "…", "legs": [ … ], "recordings": [ … ] } }
 * ```
 *
 * `nextCursor` rather than `page`/`total`/`totalPages`, unlike every PBX list. That is a real
 * divergence and it is deliberate: those three fields require a `count(*)` on each request, which
 * over a partitioned ledger is a scan of every partition in the range. The PBX tables are
 * configuration — hundreds of rows, counted for free — and this one is a billing journal that grows
 * without bound. A shared envelope would have made the wrong query cheap to write.
 */

const logger = getLogger("api.cdr");

export interface QueueStatsEnvelope {
	readonly data: readonly QueueStatsReportRow[];
	/** Echoed so a widget can label its own percentage without re-reading its own query string. */
	readonly slaSeconds: number;
	readonly range: { readonly from: string; readonly to: string };
}

/**
 * A queue's service level, with its post-call survey attached when it has one.
 *
 * `survey` is ABSENT rather than an empty summary for a queue nobody rated, which is the same
 * discipline the roster projection keeps: "no survey configured" and "a survey nobody answered" are
 * different facts, and a UI that had to tell them apart from a zero would guess wrong.
 */
export interface QueueStatsReportRow extends QueueStatsRow {
	readonly survey?: QueueSurveySummary;
}

export interface AgentStatsEnvelope {
	readonly data: readonly AgentStatsRow[];
	/** Echoed so a table can label its wrap-up column with the cap that produced it. */
	readonly wrapUpSeconds: number;
	/**
	 * The group ceiling was reached, so an agent's per-queue breakdown may be short.
	 *
	 * A flag rather than a `nextCursor`, and the difference is the point: there is no next page.
	 * `agent-stats.ts` argues why a keyset cursor over aggregate groups is a correctness problem
	 * invented to solve a size problem a tenant's agent roster does not have.
	 */
	readonly truncated: boolean;
	readonly range: { readonly from: string; readonly to: string };
}

export interface CallVolumeEnvelope {
	readonly data: readonly CallVolumeRow[];
	/** The per-destination series for the same buckets. See `call-volume.ts` for why it is separate. */
	readonly destinations: readonly CallVolumeDestinationRow[];
	readonly bucket: string;
	readonly truncated: boolean;
	readonly range: { readonly from: string; readonly to: string };
}

export interface CdrListEnvelope {
	readonly data: readonly CallLegListRow[];
	readonly nextCursor: string | null;
	readonly limit: number;
	readonly range: { readonly from: string; readonly to: string };
}

export interface CdrLegEnvelope {
	readonly data: CallLegDetailRow & { readonly recordings: readonly RecordingListRow[] };
}

export interface CdrCallEnvelope {
	readonly data: {
		readonly callId: string;
		readonly legs: readonly CallLegListRow[];
		readonly recordings: readonly RecordingListRow[];
		/** What the caller answered after the agent hung up. Empty for a call with no survey. */
		readonly survey: readonly QueueSurveyCallAnswer[];
	};
}

@Injectable()
export class CdrService {
	constructor(
		@Inject(CDR_DATABASE) private readonly database: CdrDatabaseClient,
		/**
		 * The user → extension link, when the PBX area is mounted beside this one.
		 *
		 * `@Optional()` for the reason both of the recording ports are: the two areas are siblings and
		 * either can boot without the other. See {@link CdrService.narrowing} for what its absence
		 * means to a caller who holds only the scoped grant.
		 */
		@Optional() @Inject(CDR_SELF_PARTIES) private readonly selfParties?: CdrSelfParties,
		/**
		 * Post-call survey answers, when the PBX area is mounted beside this one.
		 *
		 * `@Optional()` like its neighbour, and its absence is silent rather than an exception: a
		 * report with no survey on it is a report, whereas a `.own` reader with no extension link is
		 * a question that cannot be answered honestly. See {@link
		 * import("./queue-survey.port").CDR_QUEUE_SURVEY}.
		 */
		@Optional() @Inject(CDR_QUEUE_SURVEY) private readonly survey?: QueueSurveySource,
	) {}

	private organizationId(session: AppSession): string {
		return requireActiveOrganizationId(session);
	}

	/**
	 * The `.own` decision, in one place: `undefined` means "every row in the tenant".
	 *
	 * The endpoints' floor is `cdr.read.own`, which an unscoped `cdr.read` holder satisfies by the
	 * substitution rule — so the guard lets both in and this decides the reach, exactly as
	 * `self-ownership.ts` set out for the PBX resources. A holder of only the scoped grant on a
	 * deployment with no PBX area is refused by name: there is no link to resolve, and the two
	 * alternatives are showing them the whole tenant (a silent privilege escalation) or showing them
	 * nothing (a screen that looks broken).
	 */
	private async narrowing(
		session: AppSession,
		organizationId: string,
	): Promise<OwnedParties | undefined> {
		// `hasPermission` and not the PBX area's `holdsUnscoped`, which is the same call: importing it
		// would pull `@optimiq-voice/pbx-db` into a module that must keep booting without it.
		if (hasPermission(session.permissions ?? [], "cdr.read")) {
			return undefined;
		}
		if (this.selfParties === undefined) {
			throw new CdrSelfScopeUnavailableException();
		}
		return await this.selfParties.forUser(organizationId, session.user.id);
	}

	/**
	 * Resolves the window and refuses one that is too wide.
	 *
	 * The refusal is here rather than in the DTO because it is a policy about cost, not about
	 * shape: the schema's job is "is this a date", and "is this more history than one request may
	 * scan" is the area's. Keeping them apart is what lets an export path reuse the same DTO with a
	 * different ceiling later.
	 */
	private range(query: { readonly from?: string; readonly to?: string }): ResolvedTimeRange {
		const range = resolveTimeRange(query);
		const days = rangeDays(range);
		if (days > MAX_RANGE_DAYS) {
			throw new CdrRangeTooWideException(MAX_RANGE_DAYS, days);
		}
		return range;
	}

	/**
	 * Queue service level over a window.
	 *
	 * One tenant-scoped transaction and one grouped aggregate, exactly like every other read here —
	 * the organization is never a predicate, RLS is the filter. The `range` travels back in the
	 * envelope for the same reason the listing's does: a widget rendering "last 24 hours" should be
	 * showing the window the SERVER resolved, not the one it thinks it asked for.
	 *
	 * `MAX_RANGE_DAYS` applies unchanged through {@link CdrService.range}, and it is the right
	 * ceiling for the same reason it is on the listing: this is a live aggregate over a partitioned
	 * ledger, not a rollup, so a request's cost is proportional to the window it names.
	 */
	async queueStats(session: AppSession, query: QueueStatsQueryDto): Promise<QueueStatsEnvelope> {
		const organizationId = this.organizationId(session);
		const range = this.range(query);

		const rows = await this.database.withTenantScope(
			organizationId,
			async (transaction) =>
				await readQueueStats(transaction, {
					from: range.from,
					to: range.to,
					slaSeconds: query.slaSeconds,
					...(query.queueId === undefined ? {} : { queueId: query.queueId }),
				}),
		);

		// AFTER the aggregate and outside its transaction, because it is a different database with a
		// different tenant scope. Attached to the rows by queue id here rather than joined in SQL —
		// see the port for why no statement can name both tables.
		const surveys = await this.queueSurveys(organizationId, range, query.queueId);

		return {
			data: rows.map((row) => {
				const survey = surveys.get(row.queueId);
				return survey === undefined ? row : { ...row, survey };
			}),
			slaSeconds: query.slaSeconds,
			range: { from: range.from.toISOString(), to: range.to.toISOString() },
		};
	}

	/**
	 * Per-agent handling over a window.
	 *
	 * One tenant-scoped transaction and one grouped aggregate, exactly like {@link
	 * CdrService.queueStats} — the organization is never a predicate, RLS is the filter, and
	 * `MAX_RANGE_DAYS` applies unchanged because this is a live query rather than a rollup.
	 *
	 * It does NOT go through {@link CdrService.narrowing}. The `.own` narrowing is about which CALLS
	 * a person may see, and this endpoint returns no call: it returns counts and averages keyed on a
	 * `queue_agent` row id. Its gate is `queues.monitor` — the same aggregate grant the wallboard's
	 * service level rides, for the same reason the controller argues there.
	 */
	async agentStats(session: AppSession, query: AgentStatsQueryDto): Promise<AgentStatsEnvelope> {
		const organizationId = this.organizationId(session);
		const range = this.range(query);

		const result = await this.database.withTenantScope(
			organizationId,
			async (transaction) =>
				await readAgentStats(transaction, {
					from: range.from,
					to: range.to,
					wrapUpCeilingMs: query.wrapUpSeconds * 1_000,
					limit: query.limit,
					...(query.agentId === undefined ? {} : { agentId: query.agentId }),
					...(query.queueId === undefined ? {} : { queueId: query.queueId }),
				}),
		);

		return {
			data: result.rows,
			wrapUpSeconds: query.wrapUpSeconds,
			truncated: result.truncated,
			range: { from: range.from.toISOString(), to: range.to.toISOString() },
		};
	}

	/**
	 * Call volume over time, bucketed.
	 *
	 * `cdr.read` and not `cdr.read.own`, which is the one place this area's floor is RAISED rather
	 * than narrowed at the service layer. A bucketed count cannot be narrowed to a person's own
	 * calls without becoming a different number that looks like the same one — "we took 400 calls
	 * this week" rendered from one agent's slice is the kind of figure that ends up in a board pack.
	 * So the grant is the unscoped one and there is no narrowing branch here to get wrong.
	 */
	async callVolume(session: AppSession, query: CallVolumeQueryDto): Promise<CallVolumeEnvelope> {
		const organizationId = this.organizationId(session);
		const range = this.range(query);

		const result = await this.database.withTenantScope(
			organizationId,
			async (transaction) =>
				await readCallVolume(transaction, {
					from: range.from,
					to: range.to,
					bucket: query.bucket,
					limit: query.limit,
				}),
		);

		return {
			data: result.rows,
			destinations: result.destinations,
			bucket: query.bucket,
			truncated: result.truncated,
			range: { from: range.from.toISOString(), to: range.to.toISOString() },
		};
	}

	/**
	 * One page of legs.
	 *
	 * `CdrCursorError` is translated here rather than left to a 500: an unreadable cursor is always
	 * a client that mangled a query string, and telling it so is the difference between a form it
	 * can recover from and a page that looks broken.
	 */
	async list(session: AppSession, query: CdrListQuery): Promise<CdrListEnvelope> {
		const organizationId = this.organizationId(session);
		const range = this.range(query);
		const owned = await this.narrowing(session, organizationId);

		// Nothing to match on, so nothing to ask the ledger. An empty page and not a 403: holding no
		// extension is an ordinary state (a new member, an admin without a phone), and their own call
		// history genuinely is empty.
		const page =
			owned !== undefined && !hasAnyParty(owned)
				? { rows: [], fetched: 0 }
				: await this.database
						.withTenantScope(
							organizationId,
							async (transaction) => await listCallLegs(transaction, query, range, owned),
						)
						.catch(rethrowCursorError);

		return {
			data: page.rows,
			nextCursor: nextCursorFrom(page.rows, query.limit, page.fetched),
			limit: query.limit,
			range: { from: range.from.toISOString(), to: range.to.toISOString() },
		};
	}

	/** One leg, with any media it produced. */
	async get(session: AppSession, id: string, query: CdrLegQuery): Promise<CdrLegEnvelope> {
		const organizationId = this.organizationId(session);
		const range = this.range(query);
		// No `NaN` fallback. `cdr.dto.ts` validates `startedAt` as an ISO datetime, so an unparseable
		// value is a 400 from the schema rather than something to recover from here — and the old
		// recovery silently widened an exact partition-key seek into a full range scan, which is the
		// cost the parameter exists to avoid.
		const startedAt = query.startedAt === undefined ? undefined : new Date(query.startedAt);
		const owned = await this.narrowing(session, organizationId);
		if (owned !== undefined && !hasAnyParty(owned)) {
			throw new CdrNotFoundException("call-leg", id);
		}

		const found = await this.database.withTenantScope(organizationId, async (transaction) => {
			const leg = await getCallLeg(transaction, id, {
				...(startedAt === undefined ? {} : { startedAt }),
				range,
				...(owned === undefined ? {} : { owned }),
			});
			if (leg === undefined) {
				return undefined;
			}
			const media = await listRecordingsForLegs(transaction, [leg.id]);
			return { ...leg, recordings: media };
		});

		if (found === undefined) {
			throw new CdrNotFoundException("call-leg", id);
		}
		return { data: found };
	}

	/**
	 * Every leg of one call, plus every recording any of them produced.
	 *
	 * This is what makes a call legible rather than a list of unrelated rows: a ring-group call is
	 * one A-leg and four B-legs that share a `call_id`, each B-leg naming the leg that dialled it
	 * through `originating_leg_id` and the answered pair naming each other through `bridge_leg_id`.
	 * The UI draws the tree from those three columns; the API's job is to return the set they are
	 * drawn over, in one round trip, so the tree cannot be assembled from a half-loaded state.
	 */
	async getCall(
		session: AppSession,
		callId: string,
		query: CdrCallQuery,
	): Promise<CdrCallEnvelope> {
		const organizationId = this.organizationId(session);
		const range = this.range(query);
		const owned = await this.narrowing(session, organizationId);

		const found = await this.database.withTenantScope(organizationId, async (transaction) => {
			const legs = await listCallLegsForCall(transaction, callId, range);
			if (legs.length === 0) {
				return undefined;
			}
			// The WHOLE tree, once the caller is a party to any leg of it. Filtering leg by leg would
			// hand a ring-group answerer their own B-leg with the A-leg that originated it missing,
			// and the timeline the UI draws from `originating_leg_id` would start nowhere.
			if (owned !== undefined && !legs.some(ownPartyMatcher(owned))) {
				return undefined;
			}
			const media = await listRecordingsForLegs(
				transaction,
				legs.map((leg) => leg.id),
			);
			return { callId, legs, recordings: media };
		});

		if (found === undefined) {
			throw new CdrNotFoundException("call", callId);
		}
		// Only once the call has been found AND the `.own` check above has let this reader see it:
		// the answers are keyed by call id alone, so asking first would leak the existence of a
		// survey on a call this session may not read.
		return { data: { ...found, survey: await this.callSurvey(organizationId, callId) } };
	}

	/** Every queue's survey over the window, keyed by queue id. Empty when the port is absent. */
	private async queueSurveys(
		organizationId: string,
		range: ResolvedTimeRange,
		queueId: string | undefined,
	): Promise<ReadonlyMap<string, QueueSurveySummary>> {
		if (this.survey === undefined) {
			return new Map();
		}
		try {
			const summaries = await this.survey.summaries({
				organizationId,
				from: range.from,
				to: range.to,
				...(queueId === undefined ? {} : { queueId }),
			});
			return new Map(summaries.map((summary) => [summary.queueId, summary]));
		} catch (error) {
			// Never fatal. The service level is the answer this endpoint exists for and the survey is
			// an addition to it; a queue report that 500s because the other database is unreachable
			// would take the supervisor's whole screen with it.
			logger.warn(
				{ organizationId, err: String(error) },
				"the post-call survey summary could not be read; the queue report was served without it",
			);
			return new Map();
		}
	}

	/** What this call's caller answered. Empty when nothing was asked or the port is absent. */
	private async callSurvey(
		organizationId: string,
		callId: string,
	): Promise<readonly QueueSurveyCallAnswer[]> {
		if (this.survey === undefined) {
			return [];
		}
		try {
			return await this.survey.answersForCalls({ organizationId, callIds: [callId] });
		} catch (error) {
			logger.warn(
				{ organizationId, callId, err: String(error) },
				"the post-call survey answers could not be read; the call was served without them",
			);
			return [];
		}
	}
}

/** Turns the repository's cursor failure into the area's 400. Everything else propagates. */
function rethrowCursorError(error: unknown): never {
	if (error instanceof CdrCursorError) {
		throw new CdrInvalidCursorException(error.message);
	}
	throw error;
}
