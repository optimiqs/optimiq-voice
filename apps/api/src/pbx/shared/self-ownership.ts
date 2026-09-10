import { ForbiddenException, HttpStatus } from "@nestjs/common";
import { hasPermission } from "@optimiq-voice/auth";
import {
	deviceLine,
	eq,
	extension,
	extensionUser,
	inArray,
	voicemailBox,
} from "@optimiq-voice/pbx-db";
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
 * owned extension — and a VOICEMAIL BOX is owned through its `extensionId`. The CDR ledger has no
 * such link of its own (`cdr-db` stores numbers and entity refs, no user id), so it is reached the
 * long way round: {@link ownedExtensionParties} resolves the user's extensions to the two spellings
 * the ledger DOES record — the number and the row id — and the CDR area matches on those. Recordings
 * have no equivalent yet and stay documented as a gap; see
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

/**
 * The user's extensions as the CDR ledger spells them: the row ids AND the numbers.
 *
 * One join and one scope, for the reason `ownedVoicemailBoxIds` gives: this runs on every
 * self-scoped call-history read, and resolving the ids and the numbers separately would take two
 * connections and two `set local role` round trips to read one row set.
 *
 * Disabled extensions are included deliberately. This answers "was this person a party to that
 * call", which is a question about history — an extension disabled last week was still the one that
 * answered last month, and dropping it would silently delete calls from their own record.
 */
export async function ownedExtensionParties(
	database: PbxDatabaseClient,
	organizationId: string,
	userId: string,
): Promise<{ readonly extensionIds: readonly string[]; readonly numbers: readonly string[] }> {
	return await database.withTenantScope(organizationId, async (transaction) => {
		const rows = await transaction
			.select({ id: extension.id, number: extension.number })
			.from(extensionUser)
			.innerJoin(extension, eq(extension.id, extensionUser.extensionId))
			.where(eq(extensionUser.userId, userId));
		return { extensionIds: rows.map((row) => row.id), numbers: rows.map((row) => row.number) };
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
