import { SIP_TRANSPORTS } from "@optimiq-voice/pbx-db";
import type { ProvisioningSettings, SipTransport } from "@optimiq-voice/pbx-db";

/**
 * The organization's SIP transport preference, and how it reaches a rendered line.
 *
 * ## The migration problem this exists to solve
 *
 * `apps/asterisk` now has a TLS transport and SDES-SRTP, and every vendor template in this
 * directory has known how to write `transport=tls` since it was created — Yealink's
 * `transport_type = 2`, Grandstream's `P448`, Snom's `;tls` suffix on `user_outbound`, Fanvil's
 * `SIPn Transport`. So switching a fleet to TLS is one field.
 *
 * That is exactly why it must not be a code change. A phone's configuration is fetched on BOOT: a
 * template edit that flipped every line to TLS would take effect the next time each handset
 * power-cycled, one at a time, over days — and any handset whose firmware or certificate store
 * could not complete the handshake would simply stop registering, silently, with no correlation to
 * a deploy that happened last Tuesday. `provisioning-env.ts` already refuses to default
 * `PROVISION_SIP_TRANSPORT` to `tls` for the same reason and says so:
 *
 * > a deployment whose edge has no TLS listener would provision every phone into a state where it
 * > cannot register, and the failure would look like a broken template rather than a missing
 * > listener.
 *
 * So the switch is a SETTING, its default is `inherit`, and `inherit` reproduces today's output
 * byte for byte.
 *
 * ## Why `inherit` rather than `udp`
 *
 * Because the per-line column already exists. `device_line.transport` is `notNull().default("udp")`
 * and an administrator may have set it per handset — a defaulted org setting of `udp` would
 * silently overwrite those, which is precisely the fleet-wide surprise this design is built to
 * avoid. `inherit` means "the line decides", which is the behaviour before this file existed.
 *
 * ## Three levels, in the cascade's own order
 *
 * `code default (inherit) → org_setting.provision.sipTransport → device_line.transport`
 *
 * The org setting OVERRIDES the line rather than defaulting it, and that inversion is deliberate.
 * A transport preference is a statement about the EDGE — "this deployment's SIP edge speaks TLS" —
 * not about a handset, and an edge that has turned off its plaintext listener cannot have one phone
 * opting out of the decision. A single handset that genuinely must differ is a per-line value with
 * the org setting left at `inherit`, which is the honest way to say "we have not made this decision
 * fleet-wide yet".
 *
 * ## The port is a separate setting, and is not inferred
 *
 * It is tempting to move the port to 5061 automatically when the transport becomes TLS. It is also
 * wrong: `device_line.server_port` is `notNull` with a default, so there is no way to tell a port an
 * administrator deliberately set from one nobody ever touched, and "infer unless it was set" would
 * be a guess dressed as a rule. Every deployment that terminates TLS somewhere other than 5061 —
 * behind a border element, on a shared IP — would then be silently misprovisioned.
 *
 * So `sipPort` is its own setting, unset by default, and the catalogue entry for `sipTransport`
 * says in one sentence that TLS usually needs it. An operator flipping the transport sees both
 * fields next to each other.
 */

/** What `org_setting` may hold for `provision.sipTransport`. */
export const SIP_TRANSPORT_PREFERENCES = ["inherit", ...SIP_TRANSPORTS] as const;
export type SipTransportPreference = (typeof SIP_TRANSPORT_PREFERENCES)[number];

export const SIP_TRANSPORT_SETTING = "sipTransport";
export const SIP_PORT_SETTING = "sipPort";

/**
 * The preference as the resolved cascade carries it.
 *
 * A value that is not one of the four is treated as `inherit` rather than rejected. The cascade is
 * `jsonb` written by four levels and `org-settings.catalog.ts` states the rule for a row whose
 * stored value no longer satisfies its schema: fall back to the default rather than propagate a
 * value the reader cannot use. Refusing to render a phone's configuration over a typo in a settings
 * row would take the fleet down to protect it.
 */
export function transportPreference(settings: ProvisioningSettings): SipTransportPreference {
	const value = settings[SIP_TRANSPORT_SETTING];
	return typeof value === "string" &&
		(SIP_TRANSPORT_PREFERENCES as readonly string[]).includes(value)
		? (value as SipTransportPreference)
		: "inherit";
}

/** The transport a line actually renders with. */
export function resolveLineTransport(
	settings: ProvisioningSettings,
	lineTransport: SipTransport,
): SipTransport {
	const preference = transportPreference(settings);
	return preference === "inherit" ? lineTransport : preference;
}

/**
 * The port a line actually renders with.
 *
 * `0` and any out-of-range value are treated as unset, for the reason above: a settings row is not
 * a validated column at read time, and a phone told to register to port 0 fails in a way nobody
 * traces back to a settings screen.
 */
export function resolveLinePort(settings: ProvisioningSettings, linePort: number): number {
	const value = settings[SIP_PORT_SETTING];
	const port = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : linePort;
}
