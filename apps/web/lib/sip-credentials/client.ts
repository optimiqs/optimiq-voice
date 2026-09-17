import { apiFetch } from "../api-client";
import type { ItemEnvelope } from "../pbx/contracts";

/**
 * `/api/v1/sip-credentials` — rotating a line's SIP secret, and setting one by hand.
 *
 * `POST` on every route, because none of them is idempotent: rotating twice issues two secrets and
 * moves the grace window twice, so a retried `PUT` would silently invalidate the credential the
 * first attempt had just issued. Mirrors `sip-credential-rotation.controller.ts`.
 *
 * ## The new secret is never returned, and the UI must not pretend otherwise
 *
 * A rotation writes a new `sipSecretRef`; the password itself is DERIVED from it and a root key, so
 * there is nothing to show once and nothing to copy down. What comes back is the deadline after
 * which the old password stops being accepted, which is the only fact the operator has to act on.
 * The provisioning path hands the new credential to the handset.
 */

/** Mirrors `DEFAULT_GRACE_MINUTES` / `MAX_GRACE_MINUTES` in `sip-credential-rotation.service.ts`. */
export const DEFAULT_GRACE_MINUTES = 15;
export const MAX_GRACE_MINUTES = 1_440;

/** Mirrors `RotationResult`. `graceUntil` is `null` when the grace was zero. */
export interface RotationResult {
	readonly id: string;
	/** The extension number or the line's auth user, for the confirmation screen. */
	readonly number?: string;
	readonly graceUntil: string | null;
}

export async function rotateExtensionSecret(
	extensionId: string,
	graceMinutes: number,
): Promise<RotationResult> {
	const { data } = await apiFetch<ItemEnvelope<RotationResult>>(
		`/sip-credentials/extensions/${encodeURIComponent(extensionId)}/rotate`,
		{ method: "POST", body: JSON.stringify({ graceMinutes }) },
	);
	return data;
}

export async function rotateDeviceLineSecret(
	lineId: string,
	graceMinutes: number,
): Promise<RotationResult> {
	const { data } = await apiFetch<ItemEnvelope<RotationResult>>(
		`/sip-credentials/device-lines/${encodeURIComponent(lineId)}/rotate`,
		{ method: "POST", body: JSON.stringify({ graceMinutes }) },
	);
	return data;
}

/**
 * Sets an extension's SIP password by hand.
 *
 * The plaintext is sent and never stored — only `MD5(number:realm:password)` reaches a column. It
 * is the one path on this platform where a person chooses a SIP password, which is why it is the
 * one path with a strength check in front of it; see `./secret-strength.ts` for the mirror the
 * dialog applies before this is ever called.
 */
export async function setExtensionSecret(
	extensionId: string,
	secret: string,
): Promise<{ readonly id: string; readonly number: string }> {
	const { data } = await apiFetch<ItemEnvelope<{ id: string; number: string }>>(
		`/sip-credentials/extensions/${encodeURIComponent(extensionId)}/secret`,
		{ method: "POST", body: JSON.stringify({ secret }) },
	);
	return data;
}
