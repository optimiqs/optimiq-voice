import { Controller, Get, Inject, Query } from "@nestjs/common";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { parseDto } from "../shared/dto";
import { AuditLogQueryService } from "./audit-log-query.service";
import { auditLogQuerySchema } from "./audit-log.dto";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/audit-log` — the change ledger's read surface.
 *
 * The endpoint `shared/audit-log.service.ts` said it was waiting for: the writer landed with the
 * note "No read surface, deliberately … the endpoint lands with the permission", because an
 * endpoint guarded by `settings.read` would have put the change history of every resource behind
 * the narrowest role in the registry. `audit.read` exists now (`packages/auth/src/permissions.ts`
 * argues why it earned its own entry), so the endpoint does too.
 *
 * ## Why there is no POST, PATCH or DELETE
 *
 * `audit_log` is append-only in the database itself, not by convention: the tenant role holds
 * `SELECT, INSERT` under two policies rather than one `FOR ALL`, so it has no UPDATE or DELETE
 * privilege to expose. The only process that adds rows is the writer, inside the transaction of
 * the mutation being recorded. A "delete this entry" endpoint would be a hole in the artifact
 * whose entire value is that it has none — and it could not be implemented from this process even
 * if someone wrote one.
 *
 * ## Why there is no `GET /:id`
 *
 * A detail view would return exactly the row the listing already returned: the diff, the actor
 * and the request id are all on the list row, because a ledger entry IS its detail. The extra
 * route would be a second query path to keep tenant-safe for no new information.
 */
@Controller("api/v1/audit-log")
export class AuditLogController {
	constructor(@Inject(AuditLogQueryService) private readonly audit: AuditLogQueryService) {}

	@Get()
	@RequirePermissions("audit.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.audit.list(session, parseDto(auditLogQuerySchema, query ?? {}));
	}
}
