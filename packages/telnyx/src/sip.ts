/**
 * Telnyx's SIP edge, as constants.
 *
 * These are the values that end up in a `trunk` row and therefore in Asterisk's pjsip
 * configuration. They live here rather than in `apps/api` because a wrong hostname is not a
 * control-plane bug that shows up in a test — it is a trunk that registers nowhere and a tenant
 * whose inbound calls never arrive, discovered by a customer.
 *
 * Verified by DNS resolution on 2026-08-06; see `reference/telnyx-api.md` §SIP configuration.
 * Two Telnyx documentation pages publish a `sip-eu.telnyx.com` / `sip-ca.telnyx.com` /
 * `sip-au.telnyx.com` family that does not resolve. Do not reintroduce those names.
 */

export const TELNYX_SIP_REGIONS = [
	"us",
	"europe",
	"australia",
	"canada",
	"middle-east",
	"asia",
] as const;
export type TelnyxSipRegion = (typeof TELNYX_SIP_REGIONS)[number];

/** Region → signalling FQDN. This is both the registrar and the outbound proxy. */
export const TELNYX_SIP_DOMAINS: Readonly<Record<TelnyxSipRegion, string>> = {
	us: "sip.telnyx.com",
	europe: "sip.telnyx.eu",
	australia: "sip.telnyx.com.au",
	canada: "sip.telnyx.ca",
	"middle-east": "sip.telnyx.me",
	asia: "sip.telnyx.asia",
};

export const DEFAULT_TELNYX_SIP_REGION: TelnyxSipRegion = "us";
export const DEFAULT_TELNYX_SIP_DOMAIN = TELNYX_SIP_DOMAINS[DEFAULT_TELNYX_SIP_REGION];

/** 5060 for UDP and TCP, 5061 for TLS. */
export const TELNYX_SIP_PORT = 5060;
export const TELNYX_SIP_TLS_PORT = 5061;

/**
 * Telnyx's recommended registration expiry.
 *
 * Deliberately shorter than our `trunk.register_expires_seconds` default of 300: a registration
 * that lapses takes INBOUND calls with it (outbound is challenged per-INVITE and needs no
 * registration at all), so the refresh interval is the recovery time after a network blip.
 */
export const TELNYX_REGISTER_EXPIRES_SECONDS = 180;

/** The RTP range Telnyx sources media from — needed by whoever writes the firewall rules. */
export const TELNYX_RTP_PORT_RANGE = { start: 16_384, end: 32_768 } as const;

/** The CIDR Telnyx delivers webhooks from. */
export const TELNYX_WEBHOOK_SOURCE_CIDR = "192.76.120.192/27";

/** `<user_name>@<domain>` — the AoR a credential connection registers as. */
export function telnyxSipUri(
	userName: string,
	region: TelnyxSipRegion = DEFAULT_TELNYX_SIP_REGION,
): string {
	return `${userName}@${TELNYX_SIP_DOMAINS[region]}`;
}

export function telnyxSipDomain(region: TelnyxSipRegion = DEFAULT_TELNYX_SIP_REGION): string {
	return TELNYX_SIP_DOMAINS[region];
}

/** `sip:<domain>:<port>` — the proxy value a trunk row stores. */
export function telnyxSipProxy(region: TelnyxSipRegion = DEFAULT_TELNYX_SIP_REGION): string {
	return `sip:${TELNYX_SIP_DOMAINS[region]}:${TELNYX_SIP_PORT}`;
}
