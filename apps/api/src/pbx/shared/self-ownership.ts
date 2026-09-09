import { ForbiddenException, HttpStatus } from "@nestjs/common";
import { hasPermission } from "@optimiq-voice/auth";
import { deviceLine, eq, extensionUser, inArray, voicemailBox } from "@optimiq-voice/pbx-db";
import type { AppSession, Permission } from "@optimiq-voice/auth";
import type { PbxDatabaseClient, PbxDatabaseTransaction } from "@optimiq-voice/pbx-db";

/**
 * The `.own` enforcement seam — the row check a `.own`-scoped grant needs and a decorator cannot do.
 *
 * ## The bug this closes
 *
 * `hasPermission` treats an UNSCOPED grant as covering its scopes and never the reverse, every read
 * endpoint's guard names the unscoped grant, and the `user` role holds only `.own`-scoped grants —
 * so a `user` cleared the page (`apps/web/lib/page-permissions.ts` opens it on either grant) and
 * then met a 403 on its data call. The fix is the one `queue-agent-session.service.ts` set the
 * precedent for: lower the endpoint's floor to the `.own` grant — which an unscoped holder still
 * satisfies, by the substitution rule — and narrow the ROW here, in the service, where the row is
 * finally in hand. The decorator declares the floor; this decides the reach.
 *
 * ## Ownership is the `extension_user` link, directly or one hop out
 *
 * A user owns an EXTENSION through `extension_user` (`packages/pbx-db`, indexed on
 * `(organizationId, userId)`). A DEVICE is owned transitively — it has a `device_line` bound to an
 * owned extension — and a VOICEMAIL BOX is owned through its `extensionId`. Recordings and CDR have
 * NO such link (`cdr-db` stores numbers and entity refs, no user id), so their `.own` grants are not
 * enforceable here and stay documented as gaps; see
 * `apps/api/test/auth/permissionEnforcement.test.ts`.
 *
 * Every query runs inside `withTenantScope`, so RLS is the tenant filter and no `organization_id`
 * predicate appears — the same posture as the rest of the PBX area.
 */

/** The `extension_user` read, inside a scope somebody else already opened. */
async function extensionIdsIn(
	transaction: PbxDatabaseTransaction,
	userId: string,
): Promise<readonly string[]> {
	const rows = await transaction
		.select({ extensionId: extensionUser.extensionId })
		.from(extensionUser)
		.where(eq(extensionUser.userId, userId));
	return rows.map((row) => row.extensionId);
}

/** The extension ids the user is linked to, tenant-scoped. Empty when they hold none. */
export async function ownedExtensionIds(
	database: PbxDatabaseClient,
	organizationId: string,
	userId: string,
): Promise<readonly string[]> {
	return await database.withTenantScope(
		organizationId,
		async (transaction) => await extensionIdsIn(transaction, userId),
	);
}

/** The voicemail-box ids whose extension the user owns. Empty when they own no extension. */
export async function ownedVoicemailBoxIds(
	database: PbxDatabaseClient,
	organizationId: string,
	userId: string,
): Promise<readonly string[]> {
	// One scope, not two: this runs on every list and every single-row read for a self-service user,
	// and calling `ownedExtensionIds` here would take a second connection and a second `set local
	// role` round trip to read a set the same transaction can read itself.
	return await database.withTenantScope(organizationId, async (transaction) => {
		const extensionIds = await extensionIdsIn(transaction, userId);
		if (extensionIds.length === 0) {
			return [];
		}
		const rows = await transaction
			.select({ id: voicemailBox.id })
			.from(voicemailBox)
			.where(inArray(voicemailBox.extensionId, [...extensionIds]));
		return rows.map((row) => row.id);
	});
}

/** The device ids that carry a line bound to one of the user's extensions. */
export async function ownedDeviceIds(
	database: PbxDatabaseClient,
	organizationId: string,
	userId: string,
): Promise<readonly string[]> {
	return await database.withTenantScope(organizationId, async (transaction) => {
		const extensionIds = await extensionIdsIn(transaction, userId);
		if (extensionIds.length === 0) {
			return [];
		}
		const rows = await transaction
			.selectDistinct({ deviceId: deviceLine.deviceId })
			.from(deviceLine)
			.where(inArray(deviceLine.extensionId, [...extensionIds]));
		return rows.map((row) => row.deviceId);
	});
}

/**
 * Whether the caller holds the UNSCOPED grant, and therefore reaches every row unnarrowed.
 *
 * The one place the `.own` decision is read off the session: `true` means "act as the manager path
 * always did", `false` means "narrow to the rows they own".
 */
export function holdsUnscoped(session: AppSession, unscoped: Permission): boolean {
	return hasPermission(session.permissions ?? [], unscoped);
}

/**
 * The caller may READ the surface but does not own THIS row.
 *
 * 403 and not 404, on the `queue-agent-session` argument: the caller holds the `.own` grant that
 * opened the page, so pretending the row does not exist is a lie the list they can see contradicts.
 * The message names the actual boundary.
 */
export class SelfServiceScopeForbiddenException extends ForbiddenException {
	constructor(detail: string) {
		super({
			statusCode: HttpStatus.FORBIDDEN,
			code: "SELF_SERVICE_SCOPE_FORBIDDEN",
			message: detail,
		});
	}
}

/** The predicate a single-row read/write uses: refuse unless the id is in the owned set. */
export function assertOwnsRow(ownedIds: readonly string[], id: string, detail: string): void {
	if (!ownedIds.includes(id)) {
		throw new SelfServiceScopeForbiddenException(detail);
	}
}
