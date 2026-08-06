import { z } from "zod/v4";

/**
 * The provisioning area's environment contract.
 *
 * `zod/v4` and an app-local schema rather than a slice of `@optimiq-voice/config`, for the reasons
 * `pbx/shared/pbx-env.ts` records: `apps/api` still pins `zod@3.25.76` for its legacy surface and
 * ships the Zod 4 implementation under the `zod/v4` subpath, and `@optimiq-voice/config` owns the
 * root `.env` rather than every service's variables. This is the one place in the provisioning area
 * that may read `process.env`; everything else injects the parsed {@link ProvisioningEnv}.
 *
 * ## Why almost everything here is optional
 *
 * The device INVENTORY — MAC addresses, line assignments, key layouts, profiles — is useful on a
 * deployment that has not decided where its phones will register yet, and an administrator has to
 * be able to enter it before the SIP edge exists. So the CRUD surface mounts unconditionally with
 * the rest of the PBX area, and it is the RENDER endpoint that refuses with a 503 when the
 * deployment has not told it what to write into a phone's config.
 *
 * That mirrors the carrier slice exactly (see `pbx/carrier/carrier.module.ts`): a 503 with a code
 * the UI renders as "an operator needs to set this" is actionable, and a 404 would tell an
 * administrator that provisioning does not exist in this product.
 */

const httpUrl = z
	.string()
	.min(1)
	.regex(/^https?:\/\//iu, "must be an http(s):// URL")
	// A trailing slash would produce `…//provision/<token>/config`, which some phones normalize and
	// some fetch verbatim. Stripping it here means the URL the UI shows is the URL the phone gets.
	.transform((value) => value.replace(/\/+$/u, ""));

export const provisioningEnvSchema = z.object({
	/**
	 * The SIP registrar a provisioned phone is told to register to — the value written into
	 * `account.1.sip_server.1.address` and its four vendor equivalents.
	 *
	 * A `device_line.serverAddress` overrides it per line; this is the deployment-wide default, and
	 * it is what a device with no per-line override renders. Absent means the render endpoint has
	 * nothing to put in the field that decides whether the phone works at all, so it refuses.
	 */
	PROVISION_SIP_SERVER: z.string().min(1).max(255).optional(),

	/** The registrar's port. 5060 is the SIP default for UDP and TCP; TLS deployments use 5061. */
	PROVISION_SIP_PORT: z.coerce.number().int().min(1).max(65_535).default(5060),

	/**
	 * The transport a provisioned phone uses.
	 *
	 * Deliberately NOT defaulted to `tls`, tempting as that is: a deployment whose edge has no TLS
	 * listener would provision every phone into a state where it cannot register, and the failure
	 * would look like a broken template rather than a missing listener. The default is what a plain
	 * deployment answers on, and an operator who has TLS says so.
	 */
	PROVISION_SIP_TRANSPORT: z.enum(["udp", "tcp", "tls"]).default("udp"),

	/** Optional outbound proxy, when registration and media traverse a border element. */
	PROVISION_SIP_OUTBOUND_PROXY: z.string().max(255).optional(),

	/**
	 * The public base URL a phone reaches this API on, used to build the provisioning URL that is
	 * shown to an administrator once.
	 *
	 * It is deliberately its own variable rather than `AUTH_URL`: phones fetch their configuration
	 * from wherever the SIP edge is published, which on a real deployment is not the hostname an
	 * administrator signs in to, and building the URL from the admin origin would hand out a link
	 * that resolves for the person reading it and for nobody's desk phone.
	 */
	PROVISION_BASE_URL: httpUrl.optional(),

	/**
	 * The root key the per-line SIP password is derived from.
	 *
	 * `extension.sip_secret_ref` is a HANDLE into a secret manager — the plaintext password is
	 * deliberately not in the telephony database (see `extensions-schema.ts`) — and this deployment
	 * has no secret manager wired to that handle yet. Rather than invent a storage location for a
	 * password, the renderer DERIVES it: `hmac-sha256(key, "<organizationId>:<secretRef>")`, base64url,
	 * truncated. That is deterministic (a phone re-provisioning gets the same password it registered
	 * with), rotatable (change the key, re-provision), and stores nothing new.
	 *
	 * It is also a contract with the registrar, which must derive the same value — see
	 * `render/provision-secret.ts` for the exported derivation and the follow-up that wires it into
	 * `apps/sipd`. Absent means the render endpoint refuses rather than emitting a config with an
	 * empty password field, because a phone that provisions with no password fails to register and
	 * reports nothing an administrator can act on.
	 */
	PROVISION_SIP_SECRET_KEY: z.string().min(16).max(512).optional(),

	/**
	 * How many configuration fetches one token may make per minute.
	 *
	 * Phones fetch on boot and then on a resync schedule measured in hours, so a dozen is generous
	 * for every legitimate pattern including an administrator power-cycling a handset repeatedly.
	 * What it stops is a token that has leaked being used as an oracle.
	 */
	PROVISION_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(12),

	/**
	 * Whether an organization with NO provisioning ACL entries refuses every request.
	 *
	 * Default `false`: a deployment that has not configured an allowlist gets token authentication
	 * only, which is already the thing FusionPBX did not have. Turning it on makes the allowlist
	 * mandatory, which is right for a deployment whose phones all sit behind known static egress and
	 * wrong for one whose phones are on domestic broadband.
	 */
	PROVISION_REQUIRE_IP_ALLOWLIST: z
		.stringbool({ truthy: ["true", "1"], falsy: ["false", "0", ""] })
		.default(false),

	/** How long a freshly minted token stays valid. `0` means it does not expire. */
	PROVISION_TOKEN_TTL_DAYS: z.coerce.number().int().min(0).max(3650).default(0),
});

export type ProvisioningEnv = z.infer<typeof provisioningEnvSchema>;

export function loadProvisioningEnv(source: NodeJS.ProcessEnv = process.env): ProvisioningEnv {
	const parsed = provisioningEnvSchema.safeParse(source);
	if (!parsed.success) {
		const detail = parsed.error.issues
			.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("; ");
		throw new Error(`Invalid provisioning environment — ${detail}`);
	}
	return parsed.data;
}

/** What the render endpoint still needs before it can answer a phone. */
export function missingRenderConfiguration(env: ProvisioningEnv): readonly string[] {
	const missing: string[] = [];
	if (env.PROVISION_SIP_SERVER === undefined) {
		missing.push("PROVISION_SIP_SERVER");
	}
	if (env.PROVISION_SIP_SECRET_KEY === undefined) {
		missing.push("PROVISION_SIP_SECRET_KEY");
	}
	return missing;
}

export function isRenderConfigured(env: ProvisioningEnv): boolean {
	return missingRenderConfiguration(env).length === 0;
}
