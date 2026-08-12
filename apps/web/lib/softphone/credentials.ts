/**
 * Shaping the wire credentials into a UA configuration — the pure seam.
 *
 * Everything a browser SIP stack (`jssip`) needs to REGISTER is derived here, deterministically,
 * from `GET /api/v1/me/softphone` plus the page's own origin as a fallback. Keeping it a pure
 * function is what makes it testable without a socket: the state machine and the config are unit
 * work, the WebSocket itself is integration and lives in `jssip-adapter.ts`.
 */

import type { ResolvedSoftphoneCredentials, SoftphoneCredentialsResponse } from "./contracts";

/** The default sipd WSS port, from `apps/sipd`'s `SIPD_WSS_LISTEN_ADDR` (`0.0.0.0:8089`). */
export const DEFAULT_SIPD_WSS_PORT = 8089;

export interface ShapeCredentialsOptions {
	/**
	 * The page origin, used only to derive a WSS URL when the API did not supply one — a browser on
	 * an `https://` page can reach a co-located sipd at `wss://<host>:8089`. Pass
	 * `window.location.origin` at the call site; omitted (server / test) it simply is not used.
	 */
	readonly pageOrigin?: string;
	/** Override the fallback port. Defaults to {@link DEFAULT_SIPD_WSS_PORT}. */
	readonly fallbackWssPort?: number;
}

/**
 * Derive the socket URL a browser opens against sipd.
 *
 * Preference order, and why:
 *   1. `transport.wssUrl` from the API — authoritative, the deployment knows its own sipd address.
 *   2. Derived from the page origin — only when the page is already `https://` (an `https://` page
 *      cannot open a `ws://` socket, and a softphone that "worked" on `http://localhost` and broke
 *      in production is the worst way to learn that). Returns `wss://<host>:<port>`.
 *
 * Returns `undefined` when neither is available, which the caller surfaces as "this deployment has
 * no browser SIP transport configured" rather than guessing a URL that will not connect.
 */
export function resolveWssUrl(
	response: SoftphoneCredentialsResponse,
	options: ShapeCredentialsOptions = {},
): string | undefined {
	const explicit = response.transport.wssUrl?.trim();
	if (explicit) {
		return explicit;
	}

	const origin = options.pageOrigin?.trim();
	if (!origin) {
		return undefined;
	}

	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return undefined;
	}

	// An `https://` page can only open a `wss://` socket. Refuse to derive an insecure one rather
	// than hand back a URL a secure page's browser will block.
	if (url.protocol !== "https:") {
		return undefined;
	}

	const port = options.fallbackWssPort ?? DEFAULT_SIPD_WSS_PORT;
	return `wss://${url.hostname}:${port}`;
}

/** `1001` + `sip.example.com` -> `sip:1001@sip.example.com`. */
export function sipUriFor(username: string, realm: string): string {
	return `sip:${encodeURIComponent(username)}@${realm}`;
}

/**
 * The one-way conversion from the wire response to a UA config.
 *
 * Throws when there is no reachable WSS URL: a config without a socket is not a degraded softphone,
 * it is one that cannot exist, and the caller must show the deployment gap rather than construct a
 * UA that will only ever emit connection errors.
 */
export function shapeSoftphoneCredentials(
	response: SoftphoneCredentialsResponse,
	options: ShapeCredentialsOptions = {},
): ResolvedSoftphoneCredentials {
	const wssUrl = resolveWssUrl(response, options);
	if (!wssUrl) {
		throw new Error(
			"No WSS URL: the API did not supply transport.wssUrl and the page origin is not https, " +
				"so there is no socket a browser softphone can register over.",
		);
	}

	const { account, extension, media } = response;
	const displayName = extension.displayName.trim() || extension.number;

	return {
		wssUrl,
		sipUri: sipUriFor(account.username, account.realm),
		authorizationUser: account.authUsername,
		password: account.password,
		realm: account.realm,
		displayName,
		// jssip's `register_expires` is seconds; clamp to a sane floor so a misconfigured `0` does not
		// turn into a UA that de-registers itself immediately.
		registerExpires: account.registerExpiresSeconds > 0 ? account.registerExpiresSeconds : 600,
		extensionNumber: extension.number,
		voicemailNumber: account.voicemailNumber,
		webrtcSupported: media.webrtcSupported,
		mediaNote: media.note,
	};
}
