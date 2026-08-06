import { z } from "zod/v4";
import { TELNYX_API_BASE, TELNYX_SIP_REGIONS } from "@optimiq-voice/telnyx";

/**
 * The carrier layer's environment contract.
 *
 * ## Platform configuration, never per-tenant
 *
 * Decision D5 is explicit that the Telnyx key lives in **platform** config and never reaches a
 * browser or a tenant-scoped table. That is not a preference: one key buys numbers on one Telnyx
 * account, and every organization's DIDs are billed to it. A per-tenant key would mean either a
 * tenant can spend on the platform's account or the platform is storing customers' carrier
 * credentials — and the second is a liability nobody asked for. So the key is an env var, read
 * exactly here, injected everywhere else.
 *
 * ## Absent is a supported state
 *
 * The default developer machine has no Telnyx key, and the CI runner never will. So an unset
 * `TELNYX_API_KEY` must not be a boot failure and must not disable anything except the carrier
 * endpoints themselves — those answer 503 `CARRIER_NOT_CONFIGURED`, and every other PBX endpoint
 * is untouched. An API that refused to serve extensions because it could not buy phone numbers
 * would be a worse outage than the one it was protecting against.
 *
 * `zod/v4` for the reason `pbx-env.ts` states: `apps/api` still pins `zod@3.25.76` for legacy
 * files, and 3.25 ships the whole Zod 4 implementation under that subpath.
 */

export const carrierEnvSchema = z.object({
	/**
	 * The platform's Telnyx API key. Absent = carrier features 503; everything else unaffected.
	 */
	TELNYX_API_KEY: z.string().min(1).optional(),

	/**
	 * Overridden by the verification harness so the whole flow runs against the in-package fake.
	 * That override is the only reason `verify:carrier` can prove the ordering path end to end on
	 * a machine with no carrier account.
	 */
	TELNYX_API_BASE: z.url().default(TELNYX_API_BASE),

	/**
	 * The account's Ed25519 webhook public key, base64 of the raw 32 bytes, from the Telnyx portal.
	 *
	 * Optional and separately optional from the API key on purpose: a deployment can order numbers
	 * without accepting webhooks, and one that has not configured a key must **reject** every
	 * delivery rather than accept unverified ones. See `carrier-webhook.controller.ts`.
	 */
	TELNYX_PUBLIC_KEY: z.string().min(1).optional(),

	/**
	 * Which Telnyx signalling region provisioned trunks register to. Closed set — a typo here is a
	 * trunk that registers nowhere, discovered by a customer rather than by a test.
	 */
	TELNYX_SIP_REGION: z.enum(TELNYX_SIP_REGIONS).default("us"),

	/**
	 * Where Telnyx should deliver webhooks for connections we create. Absent means connections are
	 * provisioned without a webhook URL, which is correct for a deployment that is not reachable
	 * from the public internet — a URL that 404s would make Telnyx retry and eventually disable
	 * the endpoint.
	 */
	TELNYX_WEBHOOK_URL: z.url().optional(),

	/**
	 * Default daily spend cap, in account currency, applied to every outbound voice profile this
	 * platform creates.
	 *
	 * A string because Telnyx's own field is a decimal string and money is not a float. Set rather
	 * than left at Telnyx's default because their default is **no limit**, and an outbound voice
	 * profile with no limit is the blast radius of one leaked SIP password.
	 */
	TELNYX_DAILY_SPEND_LIMIT: z
		.string()
		.regex(/^\d+(?:\.\d{1,2})?$/u, "must be a decimal amount such as 50.00")
		.default("50.00"),

	/** Destinations a provisioned trunk may dial, ISO alpha-2, comma separated. */
	TELNYX_WHITELISTED_DESTINATIONS: z
		.string()
		.default("US,CA")
		.transform((value) =>
			value
				.split(",")
				.map((entry) => entry.trim().toUpperCase())
				.filter((entry) => entry.length === 2),
		),
});

export type CarrierEnv = z.infer<typeof carrierEnvSchema>;

/**
 * Whether the platform has a carrier at all.
 *
 * Read by the endpoints rather than by `main.ts`: the module always mounts, because the 503 that
 * tells an admin "no carrier is configured" is more useful than a 404 that tells them the feature
 * does not exist.
 */
export function isCarrierConfigured(source: NodeJS.ProcessEnv = process.env): boolean {
	return typeof source.TELNYX_API_KEY === "string" && source.TELNYX_API_KEY.length > 0;
}

export function loadCarrierEnv(source: NodeJS.ProcessEnv = process.env): CarrierEnv {
	const parsed = carrierEnvSchema.safeParse(source);
	if (!parsed.success) {
		const detail = parsed.error.issues
			.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("; ");
		throw new Error(`Invalid carrier environment — ${detail}`);
	}
	return parsed.data;
}
