import { Controller, Get, Header, Inject, Query, Res } from "@nestjs/common";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { parseDto } from "../../pbx/shared/dto";
import { tracebackCsv, tracebackFileName } from "./traceback-csv";
import { tracebackQuerySchema } from "./traceback.dto";
import { TracebackService } from "./traceback.service";
import type { AppSession } from "@optimiq-voice/auth";

/** The one thing this controller needs from the reply: a header. Structural, so a spec can pass `{}`. */
interface HeaderReply {
	header: (name: string, value: string) => unknown;
}

/**
 * `/api/v1/platform/traceback` — the industry-traceback answer surface.
 *
 * | Route         | Permission              |
 * | ------------- | ----------------------- |
 * | `GET`         | `compliance.traceback`  |
 * | `GET /export.csv` | `compliance.traceback` |
 *
 * `compliance.traceback` is its own permission and is in `OWNER_ONLY_PERMISSIONS` alongside
 * `compliance.review`, rather than being folded into it. The two are different jobs: reviewing a KYC
 * file is onboarding work done by whoever accepts customers, and answering a traceback is reading
 * every tenant's call detail records in response to a regulator. A deployment that wants one team to
 * do onboarding and another to answer subpoenas can say so, and one that wants the same team simply
 * grants both.
 *
 * ## `export.csv` is a static segment under a controller with no parametric route, so it cannot be captured
 *
 * Unlike `/api/v1/cdr/exports` under `CdrController`'s `@Get(":id")`, there is no parametric sibling
 * here for `export.csv` to collide with. Stated because the CDR module's header relies on Fastify's
 * radix router preferring a static segment, and a reader arriving from there should know this route
 * does not need that property.
 */
@Controller("api/v1/platform/traceback")
export class TracebackController {
	constructor(@Inject(TracebackService) private readonly traceback: TracebackService) {}

	@Get()
	@RequirePermissions("compliance.traceback")
	async trace(@Session() session: AppSession, @Query() query: unknown) {
		return await this.traceback.trace(session, parseDto(tracebackQuerySchema, query ?? {}));
	}

	/**
	 * The same rows as a CSV, rendered in the request.
	 *
	 * `no-store` because the file is one tenant's — several tenants' — call detail records answering a
	 * regulator, and a shared cache holding it is a copy of that nobody accounted for. The audit row is
	 * written by the same service call, so an export is as recorded as a read; they are the same query.
	 */
	@Get("export.csv")
	@RequirePermissions("compliance.traceback")
	@Header("Content-Type", "text/csv; charset=utf-8")
	@Header("Cache-Control", "private, no-store")
	async exportCsv(
		@Session() session: AppSession,
		@Query() query: unknown,
		@Res({ passthrough: true }) reply: HeaderReply,
	): Promise<string> {
		const result = await this.traceback.trace(session, parseDto(tracebackQuerySchema, query ?? {}));
		const name = tracebackFileName({
			from: new Date(result.range.from),
			to: new Date(result.range.to),
		});
		reply.header("content-disposition", `attachment; filename="${name}"`);
		return tracebackCsv(result.data);
	}
}
