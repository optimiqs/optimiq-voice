import { describe, expect, it } from "bun:test";
import {
	DEFAULT_SIPD_WSS_PORT,
	resolveWssUrl,
	shapeSoftphoneCredentials,
	sipUriFor,
	softphoneUnavailability,
} from "./credentials";
import type { SoftphoneConfiguredResponse } from "./contracts";

/**
 * The credential-shaping seam, held against the wire shape it mirrors.
 *
 * These are the assertions that catch the way a browser softphone silently fails: a WSS URL derived
 * from an `http://` origin (which a secure page cannot open), a `transport` param mistaken for the
 * socket URL, or a `register_expires` of `0` that de-registers the UA the moment it comes up.
 */

function response(
	overrides: Partial<SoftphoneConfiguredResponse> = {},
): SoftphoneConfiguredResponse {
	return {
		configured: true,
		extension: { id: "ext-1", number: "1001", label: "Reception", displayName: "Front Desk" },
		account: {
			username: "1001",
			authUsername: "1001",
			password: "s3cr3t-derived",
			realm: "sip.example.com",
			registerExpiresSeconds: 600,
			voicemailNumber: "*97",
		},
		transport: { wssUrl: "wss://sip.example.com:8089" },
		media: { webrtcSupported: false, note: "Browser audio is disabled on this deployment." },
		...overrides,
	};
}

describe("resolveWssUrl", () => {
	it("prefers the API's explicit wssUrl", () => {
		expect(resolveWssUrl(response(), { pageOrigin: "https://app.example.com" })).toBe(
			"wss://sip.example.com:8089",
		);
	});

	it("derives wss://host:8089 from an https page origin when the API gives none", () => {
		const derived = resolveWssUrl(response({ transport: { wssUrl: null } }), {
			pageOrigin: "https://voice.acme.com",
		});
		expect(derived).toBe(`wss://voice.acme.com:${DEFAULT_SIPD_WSS_PORT}`);
	});

	it("refuses to derive an insecure socket from an http origin", () => {
		// An https page cannot open ws://, so a URL derived from http:// would only ever fail to connect.
		expect(
			resolveWssUrl(response({ transport: { wssUrl: null } }), {
				pageOrigin: "http://localhost:3100",
			}),
		).toBeUndefined();
	});

	it("returns undefined when there is neither an explicit URL nor an origin", () => {
		expect(resolveWssUrl(response({ transport: { wssUrl: null } }))).toBeUndefined();
	});

	it("honours a fallback port override", () => {
		expect(
			resolveWssUrl(response({ transport: { wssUrl: null } }), {
				pageOrigin: "https://voice.acme.com",
				fallbackWssPort: 7443,
			}),
		).toBe("wss://voice.acme.com:7443");
	});
});

describe("sipUriFor", () => {
	it("builds a sip: AOR from the user and realm", () => {
		expect(sipUriFor("1001", "sip.example.com")).toBe("sip:1001@sip.example.com");
	});
});

describe("shapeSoftphoneCredentials", () => {
	it("preserves expiring TURN credentials for the peer connection", () => {
		const ice = {
			urls: ["turn:turn.example.test:3478"],
			username: "12345:org:user",
			credential: "expiring-hmac",
		};
		const shaped = shapeSoftphoneCredentials(
			response({ media: { webrtcSupported: true, note: "Enabled", iceServers: [ice] } }),
		);
		expect(shaped.iceServers).toEqual([ice]);
		expect(shaped.iceServers?.[0]?.urls).not.toBe(ice.urls);
		expect(shaped.webrtcSupported).toBe(true);
	});

	it("maps the wire response onto a UA config", () => {
		const shaped = shapeSoftphoneCredentials(response());
		expect(shaped.wssUrl).toBe("wss://sip.example.com:8089");
		expect(shaped.sipUri).toBe("sip:1001@sip.example.com");
		expect(shaped.authorizationUser).toBe("1001");
		expect(shaped.password).toBe("s3cr3t-derived");
		expect(shaped.realm).toBe("sip.example.com");
		expect(shaped.displayName).toBe("Front Desk");
		expect(shaped.registerExpires).toBe(600);
		expect(shaped.extensionNumber).toBe("1001");
		expect(shaped.voicemailNumber).toBe("*97");
		expect(shaped.webrtcSupported).toBe(false);
	});

	it("falls back the display name to the extension number when blank", () => {
		const shaped = shapeSoftphoneCredentials(
			response({
				extension: { id: "e", number: "1001", label: "", displayName: "   " },
			}),
		);
		expect(shaped.displayName).toBe("1001");
	});

	it("clamps a non-positive register-expires to a sane floor", () => {
		const shaped = shapeSoftphoneCredentials(
			response({
				account: { ...response().account, registerExpiresSeconds: 0 },
			}),
		);
		expect(shaped.registerExpires).toBe(600);
	});

	it("throws when there is no reachable WSS URL rather than building a dead UA", () => {
		expect(() =>
			shapeSoftphoneCredentials(response({ transport: { wssUrl: null } }), {
				pageOrigin: "http://localhost:3100",
			}),
		).toThrow(/WSS URL/u);
	});
});

describe("why the softphone is unavailable", () => {
	it("sends an administrator to Settings when the organization has no SIP domain", () => {
		// There is no deployment-wide realm to fall back on — one realm names exactly one tenant — so
		// the API names the state and the only useful answer is the page that fixes it.
		expect(
			softphoneUnavailability({ reason: "no-realm", hasCredentials: false, resolved: false }),
		).toEqual({
			reason:
				"SIP domain not configured for this organization. Set the calling domain in Settings.",
			href: "/settings",
		});
	});

	it("offers no link for a caller who simply holds no extension", () => {
		const { reason, href } = softphoneUnavailability({
			reason: "no-extension",
			hasCredentials: false,
			resolved: false,
		});
		expect(reason).toContain("No extension is assigned to you");
		expect(href).toBeNull();
	});

	it("names the deployment gap when browser calling was never provisioned", () => {
		const { reason, href } = softphoneUnavailability({
			reason: "not-provisioned",
			hasCredentials: false,
			resolved: false,
		});
		expect(reason).toContain("not configured on this deployment");
		expect(href).toBeNull();
	});

	it("still maps the pre-union refusals, for an API that predates the 200 contract", () => {
		expect(
			softphoneUnavailability({ status: 404, hasCredentials: false, resolved: false }).reason,
		).toContain("No extension is assigned to you");
		expect(
			softphoneUnavailability({
				status: 503,
				code: "SOFTPHONE_NO_REALM",
				hasCredentials: false,
				resolved: false,
			}).href,
		).toBe("/settings");
	});

	it("names the missing browser transport when credentials arrived but could not be shaped", () => {
		const { reason, href } = softphoneUnavailability({ hasCredentials: true, resolved: false });
		expect(reason).toContain("sipd WSS");
		expect(href).toBeNull();
	});

	it("is silent when the softphone is available", () => {
		expect(softphoneUnavailability({ hasCredentials: true, resolved: true })).toEqual({
			reason: null,
			href: null,
		});
	});
});
