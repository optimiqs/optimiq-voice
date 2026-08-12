/**
 * The softphone contract — mirrored, never imported.
 *
 * Same rule as every other `lib/` mirror (`lib/pbx/contracts.ts`, `lib/provisioning/contracts.ts`):
 * `apps/api` is a Nest application and importing its DTOs drags `@nestjs/common`, `zod/v4` and
 * `@optimiq-voice/pbx-db` — and therefore Drizzle and a Postgres driver — into the browser bundle.
 *
 * ## The honesty boundary, stated once
 *
 * `apps/sipd`'s `README.md` and `main.go` are explicit: the `SIPD_WSS` listener (RFC 7118,
 * `wss://<host>:8089` by default) is the ONLY transport a browser softphone has, and it delivers
 * **SIGNALLING ONLY**. A WebRTC endpoint needs DTLS-SRTP and `apps/mediad` has no SRTP yet, so a
 * call placed from this softphone can REGISTER, ring and tear down over WSS but carries no audio.
 * `webrtcSupported` is that fact, on the wire, so the UI never pretends otherwise.
 *
 * ## The wire-up seam (documented, not yet committed)
 *
 * The credential-delivery endpoint below (`GET /api/v1/me/softphone`) does not exist in the tree
 * yet. What DOES exist and this is modelled on:
 *   - `apps/api/src/provisioning/catalog/templates/softphone.ts#SoftphoneAccountPayload` — the exact
 *     `{ username, authUsername, password, domain, server, port, transport, registerExpiresSeconds,
 *     voicemailNumber }` shape a softphone consumes, served today (for an admin-created device) by
 *     the public `GET /provision/:token/payload` route.
 *   - `apps/api/src/pbx/sip-credentials/sip-credentials.service.ts` — the bare-extension path
 *     (`findExtension`) that authenticates a softphone with no device row, keyed on `extension.number`.
 *   - `packages/pbx-db`'s `extension_user` table (roles `primary` / `shared` / `delegate`) — the
 *     userId → extension binding a self-service endpoint reads to know the caller's own extension.
 *
 * A self-service endpoint is the honest home for this: a regular user holding an extension must be
 * able to obtain THEIR OWN softphone credentials without holding `devices.write`, and the plaintext
 * SIP password only reaches the browser through a payload-style read (an HA1 digest cannot drive a
 * browser SIP stack that must answer arbitrary-realm challenges). Two facts the committed pieces
 * cannot yet supply and this endpoint must add: the sipd **WSS URL** (no contract exposes it today)
 * and the userId → extension resolution.
 */

/** The caller's own extension, as a self-service `GET /api/v1/me/softphone` would report it. */
export interface SoftphoneExtension {
	readonly id: string;
	readonly number: string;
	readonly label: string;
	/** What the far end sees / the phone shows for this account. */
	readonly displayName: string;
}

/** The SIP account fields — a strict subset of the committed `SoftphoneAccountPayload`. */
export interface SoftphoneAccount {
	/** The REGISTER AOR user — the extension number. */
	readonly username: string;
	/** The digest auth id — `device_line.authUser ?? number`. Usually equal to `username`. */
	readonly authUsername: string;
	/** The plaintext SIP password. A credential; see the file header. */
	readonly password: string;
	/** The SIP realm / domain accounts register into (`SIPD_REALM`). */
	readonly realm: string;
	readonly registerExpiresSeconds: number;
	/** The MWI mailbox this account subscribes to, when the extension has one. */
	readonly voicemailNumber: string | null;
}

/** How a browser reaches sipd. The `wssUrl` is the piece no committed contract exposes yet. */
export interface SoftphoneTransport {
	/** The sipd WSS listener, e.g. `wss://sip.example.com:8089`. `null` when the deployment has none. */
	readonly wssUrl: string | null;
}

/** The platform's own statement about whether media can flow — see the file header. */
export interface SoftphoneMedia {
	/**
	 * `false` until `apps/mediad` ships DTLS-SRTP. When `false`, the softphone registers and signals
	 * but no audio traverses the platform's media plane.
	 */
	readonly webrtcSupported: boolean;
	readonly note: string;
}

/** The documented wire shape of `GET /api/v1/me/softphone`. */
export interface SoftphoneCredentialsResponse {
	readonly extension: SoftphoneExtension;
	readonly account: SoftphoneAccount;
	readonly transport: SoftphoneTransport;
	readonly media: SoftphoneMedia;
}

/**
 * What the SIP user agent actually needs, fully resolved — no NULLs the UA would have to decide on.
 *
 * Produced by `shapeSoftphoneCredentials` from the wire response; the shaping is the pure,
 * unit-tested seam between "what the API returned" and "what jssip is configured with".
 */
export interface ResolvedSoftphoneCredentials {
	/** The socket URL jssip opens, e.g. `wss://sip.example.com:8089`. */
	readonly wssUrl: string;
	/** The AOR, e.g. `sip:1001@sip.example.com`. */
	readonly sipUri: string;
	readonly authorizationUser: string;
	readonly password: string;
	readonly realm: string;
	readonly displayName: string;
	readonly registerExpires: number;
	readonly extensionNumber: string;
	readonly voicemailNumber: string | null;
	readonly webrtcSupported: boolean;
	readonly mediaNote: string;
}
