import { createHash, randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import { getLogger } from "@optimiq-voice/logging";
import { and, deviceLine, eq, extension, orgSetting, sql } from "@optimiq-voice/pbx-db";
import { actorFromSession, insertAuditLog } from "../shared/audit-log";
import { PbxEntityNotFoundFailure, PbxValidationFailure } from "../shared/pbx.errors";
import { PBX_DATABASE } from "../shared/pbx.tokens";
import { SipCredentialCache } from "./sip-credentials.cache";
import { weakSipSecretMessage, weakSipSecretReason } from "./sip-secret-strength";
import type { AppSession } from "@optimiq-voice/auth";
import type { PbxDatabaseClient, PbxDatabaseTransaction } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.pbx");

/**
 * How long the outgoing secret keeps working, unless the caller says otherwise.
 *
 * Fifteen minutes. Long enough for a phone that polls its provisioning URL on the usual few-minute
 * interval, and for an operator to push a resync and watch it land. Short enough that a rotation
 * performed BECAUSE the old credential leaked does not leave it usable for the rest of the shift —
 * which is the case the grace period is most at risk of undermining, and the reason
 * {@link SipCredentialRotationService.rotate} accepts zero.
 */
export const DEFAULT_GRACE_MINUTES = 15;

/** The longest grace this platform will hold open. A day is already generous for a phone reboot. */
export const MAX_GRACE_MINUTES = 1_440;

/**
 * Rotating a line's SIP secret, and setting one by hand.
 *
 * ## What a rotation actually changes
 *
 * The password is DERIVED — `hmac-sha256(rootKey, "<orgId>:<secretRef>")`, per
 * `provision-secret.ts` — so rotating it means changing the `secretRef`, which is an opaque handle
 * and not a credential. Nothing here ever holds a password: the new one exists only when the
 * renderer computes it for a config the phone fetches, and when the credential responder computes
 * the digest to compare against.
 *
 * That is what makes rotation cheap and it is also what makes the grace period necessary. The
 * platform is authoritative for the new secret the instant this row commits, but the HANDSET does
 * not learn it until it fetches its config — on a schedule the handset owns. Between those two
 * instants a phone with the old password would fail to register, silently, and the symptom is a desk
 * phone that has stopped ringing with nothing in any log the operator reads.
 *
 * So the OLD handle is kept alongside the new one until an expiry, and the credential responder
 * accepts either while that holds. Keeping the old rather than staging the new is the deliberate
 * half: the audit row, the rendered config and the credential reply all agree from the moment of
 * the write, and the only thing with a deadline is the value on its way out. Staging the new one
 * would leave a window where the config a phone fetches and the credential the platform accepts
 * disagree, which is the bug this design exists to prevent.
 *
 * ## Why a hand-set secret is a different endpoint
 *
 * {@link SipCredentialRotationService.setSecret} writes `extension.sip_password_ha1`, the escape
 * hatch for a handset that cannot take a provisioned config. It is the ONE path on this platform
 * where a person chooses a SIP password, and it is therefore the one path that needs a strength
 * check — `sip-secret-strength.ts` says why at length. It also has no grace: a stored digest is a
 * single value with no history, so there is nothing to keep working.
 */
@Injectable()
export class SipCredentialRotationService {
	constructor(
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		@Inject(SipCredentialCache) private readonly cache: SipCredentialCache,
	) {}

	protected organizationId(session: AppSession): string {
		return requireActiveOrganizationId(session);
	}

	/**
	 * Issues a new secret handle for one extension, keeping the old one valid for `graceMinutes`.
	 *
	 * `graceMinutes: 0` closes the window immediately, which is what a rotation performed BECAUSE a
	 * credential leaked wants: the point of that rotation is that the old password stops working,
	 * and a fifteen-minute courtesy to the handset is fifteen minutes to whoever has the password.
	 * The default is the courtesy; naming zero is the incident response.
	 */
	async rotateExtension(
		session: AppSession,
		extensionId: string,
		graceMinutes: number = DEFAULT_GRACE_MINUTES,
	): Promise<RotationResult> {
		const organizationId = this.organizationId(session);
		const actor = actorFromSession(session);
		const result = await this.database.withTenantScope(organizationId, async (transaction) => {
			const rows = await transaction
				.select({ id: extension.id, number: extension.number, secretRef: extension.sipSecretRef })
				.from(extension)
				.where(eq(extension.id, extensionId))
				.limit(1);
			const row = rows[0];
			if (row === undefined) {
				throw new PbxEntityNotFoundFailure({ kind: "extension", id: extensionId });
			}
			const next = newSecretRef();
			const graceUntil = graceExpiry(graceMinutes);
			await transaction
				.update(extension)
				.set({
					sipSecretRef: next,
					sipSecretRefPrevious: row.secretRef,
					sipSecretGraceUntil: graceUntil,
					// A rotation supersedes a hand-set digest. Leaving it would make the rotation a
					// no-op that reported success — `sip-credentials.service.ts` prefers the stored HA1
					// over every derivation, so the phone would keep authenticating with the old
					// hand-set password and nobody would find out until the next incident.
					sipPasswordHa1: null,
				} as never)
				.where(eq(extension.id, extensionId));
			await this.audit(transaction, organizationId, actor, {
				action: "extension.rotate-sip-secret",
				resourceType: "extension",
				resourceRef: extensionId,
				graceUntil,
			});
			return { id: extensionId, number: row.number, graceUntil };
		});
		// The edge caches credential replies; a rotation whose cache was not dropped is a rotation
		// that takes effect whenever the cache happens to expire. Invalidated AFTER the commit, so a
		// rolled-back rotation cannot have cleared a cache that was correct.
		this.cache.invalidate(organizationId, "extension.rotate-sip-secret");
		logger.info(
			{ organizationId, extensionId, graceUntil: result.graceUntil },
			"an extension's SIP secret was rotated",
		);
		return result;
	}

	/**
	 * The same, for one device line.
	 *
	 * A separate entry point rather than a `kind` parameter, because the two rows resolve
	 * differently: the credential path reads `coalesce(extension.sip_secret_ref,
	 * device_line.sip_secret_ref)`, so rotating a LINE whose extension carries a handle changes
	 * nothing at all. That is refused here rather than silently succeeding — a rotation that reports
	 * success and does not rotate is the worst outcome available.
	 */
	async rotateDeviceLine(
		session: AppSession,
		lineId: string,
		graceMinutes: number = DEFAULT_GRACE_MINUTES,
	): Promise<RotationResult> {
		const organizationId = this.organizationId(session);
		const actor = actorFromSession(session);
		const result = await this.database.withTenantScope(organizationId, async (transaction) => {
			const rows = await transaction
				.select({
					id: deviceLine.id,
					secretRef: deviceLine.sipSecretRef,
					extensionSecretRef: extension.sipSecretRef,
					authUser: deviceLine.authUser,
				})
				.from(deviceLine)
				.leftJoin(
					extension,
					sql`${extension.id} = coalesce(${deviceLine.homeExtensionId}, ${deviceLine.extensionId})`,
				)
				.where(eq(deviceLine.id, lineId))
				.limit(1);
			const row = rows[0];
			if (row === undefined) {
				throw new PbxEntityNotFoundFailure({ kind: "device_line", id: lineId });
			}
			if (row.extensionSecretRef !== null && row.extensionSecretRef !== undefined) {
				throw new PbxValidationFailure({
					field: "lineId",
					detail:
						"This line authenticates with its extension's SIP secret, so rotating the line " +
						"would change nothing. Rotate the extension instead.",
				});
			}
			const next = newSecretRef();
			const graceUntil = graceExpiry(graceMinutes);
			await transaction
				.update(deviceLine)
				.set({
					sipSecretRef: next,
					sipSecretRefPrevious: row.secretRef,
					sipSecretGraceUntil: graceUntil,
				} as never)
				.where(eq(deviceLine.id, lineId));
			await this.audit(transaction, organizationId, actor, {
				action: "device-line.rotate-sip-secret",
				resourceType: "device_line",
				resourceRef: lineId,
				graceUntil,
			});
			return { id: lineId, number: row.authUser ?? undefined, graceUntil };
		});
		this.cache.invalidate(organizationId, "device-line.rotate-sip-secret");
		logger.info(
			{ organizationId, lineId, graceUntil: result.graceUntil },
			"a device line's SIP secret was rotated",
		);
		return result;
	}

	/**
	 * Sets one extension's SIP password by hand, storing only its digest.
	 *
	 * The plaintext exists in this process for the length of one `createHash` call and is never
	 * written, logged or returned — `extension.sip_password_ha1` is on `secretColumns`, so even the
	 * audit ledger records that the column changed and not what it changed to.
	 *
	 * The realm is read here rather than taken from the caller, because the digest binds it:
	 * `MD5(username:realm:password)` computed against the wrong realm is a credential no phone can
	 * ever match, and a caller-supplied realm is the easiest way to produce one. A tenant with no
	 * realm configured is refused, for the same reason — there is nothing to bind to.
	 */
	async setSecret(
		session: AppSession,
		extensionId: string,
		secret: string,
	): Promise<{ readonly id: string; readonly number: string }> {
		const weak = weakSipSecretReason(secret);
		if (weak !== undefined) {
			throw new PbxValidationFailure({ field: "secret", detail: weakSipSecretMessage(weak) });
		}
		const organizationId = this.organizationId(session);
		const actor = actorFromSession(session);
		const result = await this.database.withTenantScope(organizationId, async (transaction) => {
			const realm = await this.realmFor(transaction);
			if (realm === undefined) {
				throw new PbxValidationFailure({
					field: "secret",
					detail:
						"This organization has no SIP realm configured, and a stored digest binds the " +
						"realm it was computed against. Set the SIP domain first.",
				});
			}
			const rows = await transaction
				.select({ id: extension.id, number: extension.number })
				.from(extension)
				.where(eq(extension.id, extensionId))
				.limit(1);
			const row = rows[0];
			if (row === undefined) {
				throw new PbxEntityNotFoundFailure({ kind: "extension", id: extensionId });
			}
			const ha1 = createHash("md5")
				.update(`${row.number}:${realm}:${secret}`, "utf8")
				.digest("hex");
			await transaction
				.update(extension)
				.set({
					sipPasswordHa1: ha1,
					// A hand-set digest has no history, so any open grace from an earlier rotation is
					// closed with it: leaving one would keep a derived password working alongside a
					// password an operator just chose, which is two live credentials nobody asked for.
					sipSecretRefPrevious: null,
					sipSecretGraceUntil: null,
				} as never)
				.where(eq(extension.id, extensionId));
			await insertAuditLog(transaction, {
				organizationId,
				actor,
				action: "extension.set-sip-secret",
				resourceType: "extension",
				resourceRef: extensionId,
				before: null,
				// The COLUMN is named and the value is not, which is the ledger's own rule for a secret
				// column — `audit-log.ts` states it: "somebody rotated this extension's SIP password" is
				// the auditable fact; the password is not.
				after: { sipPasswordHa1: "[redacted]" },
			});
			return { id: row.id, number: row.number };
		});
		this.cache.invalidate(organizationId, "extension.set-sip-secret");
		logger.info(
			{ organizationId, extensionId },
			"an extension's SIP password was set by hand; the derived secret no longer applies",
		);
		return result;
	}

	private async realmFor(transaction: PbxDatabaseTransaction): Promise<string | undefined> {
		const rows = await transaction
			.select({ value: orgSetting.value })
			.from(orgSetting)
			.where(
				and(
					eq(orgSetting.category, "sip"),
					eq(orgSetting.name, "realm"),
					eq(orgSetting.enabled, true),
				),
			)
			.limit(1);
		const value = rows[0]?.value;
		return typeof value === "string" && value.trim().length > 0
			? value.trim().toLowerCase()
			: undefined;
	}

	private async audit(
		transaction: PbxDatabaseTransaction,
		organizationId: string,
		actor: ReturnType<typeof actorFromSession>,
		entry: {
			readonly action: string;
			readonly resourceType: string;
			readonly resourceRef: string;
			readonly graceUntil: Date | null;
		},
	): Promise<void> {
		await insertAuditLog(transaction, {
			organizationId,
			actor,
			action: entry.action,
			resourceType: entry.resourceType,
			resourceRef: entry.resourceRef,
			before: null,
			// Neither handle appears: a `secretRef` is not a credential, but it is the whole input to
			// the derivation that produces one, and a ledger anyone with SELECT can read is not where
			// it belongs. What is recorded is that a rotation happened and when the old one stops.
			after: {
				sipSecretRef: "[redacted]",
				graceUntil: entry.graceUntil === null ? null : entry.graceUntil.toISOString(),
			},
		});
	}
}

export interface RotationResult {
	readonly id: string;
	/** The extension number or the line's auth user, for the operator's confirmation screen. */
	readonly number?: string;
	/** When the previous secret stops being accepted. `null` when the grace was zero. */
	readonly graceUntil: Date | null;
}

/**
 * A fresh secret handle.
 *
 * Random rather than derived from anything about the row, because a handle that encoded the
 * extension id and a counter would let anyone who saw one predict the next — and the handle is the
 * whole input to the password derivation. 32 bytes of `randomBytes`, base64url, which is the same
 * alphabet `provision-secret.ts` renders passwords in and therefore travels through the same
 * templates without escaping.
 */
export function newSecretRef(): string {
	return randomBytes(32).toString("base64url");
}

/** `null` for a zero grace, which is the incident-response case. See {@link rotateExtension}. */
export function graceExpiry(minutes: number): Date | null {
	if (minutes <= 0) {
		return null;
	}
	return new Date(Date.now() + Math.min(minutes, MAX_GRACE_MINUTES) * 60_000);
}
