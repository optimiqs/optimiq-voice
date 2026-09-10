import { Body, Controller, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod/v4";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { parseDto } from "../shared/dto";
import {
	DEFAULT_GRACE_MINUTES,
	MAX_GRACE_MINUTES,
	SipCredentialRotationService,
} from "./sip-credential-rotation.service";
import { MIN_SIP_SECRET_LENGTH } from "./sip-secret-strength";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/sip-credentials` — rotating a line's SIP secret, and setting one by hand.
 *
 * `POST` rather than `PUT` on every route here, and the reason is that none of them is idempotent
 * in the way a `PUT` promises: rotating twice issues two secrets and moves the grace window twice,
 * which is a materially different state from rotating once. A `PUT` that a client retried on a
 * timeout would silently invalidate the credential its first attempt had just issued.
 *
 * Guarded by `security.rotate-credentials`, which is deliberately not `security.write` and not
 * `extensions.write` — the registry entry argues both. The short version: opening a CIDR is a change
 * made while looking at a list, and invalidating the credential a physical handset is holding is an
 * outage on a schedule the handset chooses.
 */
@Controller("api/v1/sip-credentials")
export class SipCredentialRotationController {
	constructor(
		@Inject(SipCredentialRotationService)
		private readonly rotation: SipCredentialRotationService,
	) {}

	@Post("extensions/:extensionId/rotate")
	@RequirePermissions("security.rotate-credentials")
	async rotateExtension(
		@Session() session: AppSession,
		@Param("extensionId") extensionId: string,
		@Body() body: unknown,
	) {
		const input = parseDto(rotateSecretDto, body ?? {});
		return {
			data: await this.rotation.rotateExtension(session, extensionId, input.graceMinutes),
		};
	}

	@Post("device-lines/:lineId/rotate")
	@RequirePermissions("security.rotate-credentials")
	async rotateDeviceLine(
		@Session() session: AppSession,
		@Param("lineId") lineId: string,
		@Body() body: unknown,
	) {
		const input = parseDto(rotateSecretDto, body ?? {});
		return { data: await this.rotation.rotateDeviceLine(session, lineId, input.graceMinutes) };
	}

	/**
	 * Sets an extension's SIP password by hand.
	 *
	 * The plaintext is accepted and never stored — only `MD5(number:realm:password)` reaches a
	 * column, and it is on `secretColumns` so the audit ledger records the change without the value.
	 * It is also the one path on this platform where a person chooses a SIP password, which is why
	 * it is the one path with a strength check in front of it.
	 */
	@Post("extensions/:extensionId/secret")
	@RequirePermissions("security.rotate-credentials")
	async setSecret(
		@Session() session: AppSession,
		@Param("extensionId") extensionId: string,
		@Body() body: unknown,
	) {
		const input = parseDto(setSecretDto, body);
		return { data: await this.rotation.setSecret(session, extensionId, input.secret) };
	}
}

/**
 * How long the outgoing secret keeps working.
 *
 * `0` is legal and is the incident-response case: a rotation performed BECAUSE a credential leaked
 * wants the old password to stop working now, and a courtesy window to the handset is a courtesy
 * window to whoever has the password. Absent takes {@link DEFAULT_GRACE_MINUTES}.
 */
export const rotateSecretDto = z.strictObject({
	graceMinutes: z.int().min(0).max(MAX_GRACE_MINUTES).default(DEFAULT_GRACE_MINUTES),
});

/**
 * The plaintext, bounded only at the edges.
 *
 * The real rules live in `sip-secret-strength.ts` and are applied in the service, not here: they
 * return a REASON, and a caller who is told "at least twelve characters, three character classes"
 * can act where one told "invalid" cannot. The DTO's own maximum exists so an attacker-chosen
 * megabyte never reaches an MD5.
 */
export const setSecretDto = z.strictObject({
	secret: z.string().min(MIN_SIP_SECRET_LENGTH).max(128),
});
