import { z } from "zod/v4";

/**
 * The messaging area's environment contract.
 *
 * Self-contained, like `carrier-env.ts` and `fax-env.ts`: messaging adds a provider driver, a media
 * store root, two worker cadences and a link-signing secret, and none of them mean anything to the
 * rest of the platform. A deployment with none of this set runs every other endpoint untouched —
 * the workers do not arm and the messaging endpoints answer 503 with a reason.
 *
 * `zod/v4` for the reason the sibling env files state: `apps/api` still pins `zod@3.25.76` for
 * legacy files, and 3.25 ships the whole Zod 4 implementation under that subpath.
 */

/**
 * Which provider backs messaging.
 *
 * `telnyx` is the real carrier. `fake` is an in-process double that records what it was asked to
 * send and can be driven to deliver an inbound message — it is what the local stack and the api
 * tests run against, and it is why the whole feature is provable without a carrier account or a
 * public webhook URL. `none` is the honest default: a deployment that has not chosen a provider has
 * no messaging, and saying so is better than silently pretending to send.
 */
export const MESSAGING_DRIVERS = ["none", "telnyx", "fake"] as const;
export type MessagingDriver = (typeof MESSAGING_DRIVERS)[number];

export const messagingEnvSchema = z.object({
	MESSAGING_DRIVER: z.enum(MESSAGING_DRIVERS).default("none"),

	/**
	 * The Telnyx messaging profile every number is attached to when messaging is enabled on it.
	 *
	 * Platform-level for the same reason `TELNYX_API_KEY` is: one Telnyx account holds the profiles
	 * and bills for the traffic. Absent means a number can still be enabled — the row is created and
	 * its registration state tracked — but the carrier-side attachment is left to an operator, and
	 * the send path says so rather than failing opaquely.
	 */
	TELNYX_MESSAGING_PROFILE_ID: z.string().min(1).optional(),

	/**
	 * Where MMS parts are stored, inbound and outbound.
	 *
	 * Its own root rather than a ride on the media mount, for the reason the fax store gives: nothing
	 * in the media plane ever reads these bytes — they are written by this API and served back over a
	 * signed link — so they are the one object class an operator can legitimately place elsewhere.
	 */
	MESSAGING_OBJECT_ROOT: z.string().min(1).default("./.data/messaging"),

	/** The send worker's master switch. Same shape and argument as `FAX_SEND_ENABLED`. */
	MESSAGING_SEND_ENABLED: z
		.stringbool({ truthy: ["true", "1"], falsy: ["false", "0", ""] })
		.default(true),

	/** Send-queue poll interval. `0` disables the worker without disabling the API. */
	MESSAGING_SEND_POLL_INTERVAL_MS: z.coerce.number().int().min(0).max(3_600_000).default(2_000),

	/**
	 * How long a claimed but unfinished send may sit before another pass reclaims it. Shorter than
	 * fax's two minutes because a text is expected to land in seconds and a stuck one is visible to
	 * the person who typed it.
	 */
	MESSAGING_SEND_LEASE_MS: z.coerce.number().int().min(10_000).max(86_400_000).default(60_000),

	/** How many times a send is attempted before the row is terminally `failed`. */
	MESSAGING_SEND_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),

	/**
	 * How often the registration poller reconciles brands, campaigns and toll-free submissions
	 * against the carrier. `0` disables it.
	 *
	 * Slow on purpose: TCR brand vetting takes minutes to days and carrier campaign review takes
	 * days, so a fast poll buys nothing and spends the account's shared rate limit — which the number
	 * ordering path also draws on.
	 */
	MESSAGING_REGISTRATION_POLL_INTERVAL_MS: z.coerce
		.number()
		.int()
		.min(0)
		.max(86_400_000)
		.default(300_000),

	/**
	 * Default retention for message bodies and MMS media, in days, for a number with no policy of
	 * its own. `0` means keep — the same convention `CDR_LEG_RETENTION_MONTHS` uses, and the same
	 * caveat: `0` is a choice a deployment has to unmake deliberately, because storage limitation
	 * under GDPR Art. 5(1)(e) is a per-class obligation and this is one of the classes.
	 */
	MESSAGING_RETENTION_DAYS: z.coerce.number().int().min(0).max(3_650).default(0),

	/** Retention sweep cadence. `0` disables the sweeper. */
	MESSAGING_RETENTION_SWEEP_INTERVAL_MS: z.coerce
		.number()
		.int()
		.min(0)
		.max(86_400_000)
		.default(3_600_000),

	/**
	 * The secret that signs MMS media links. Absent = no link is minted and the inbox renders the
	 * attachment as unavailable rather than as a broken image.
	 */
	MESSAGING_MEDIA_URL_SECRET: z.string().min(1).optional(),

	/** The previous secret, so a rotation does not break links already on somebody's screen. */
	MESSAGING_MEDIA_URL_SECRET_PREVIOUS: z.string().min(1).optional(),

	/** Lifetime of a minted media link, in seconds. */
	MESSAGING_MEDIA_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(86_400).default(3_600),

	/**
	 * The publicly-reachable origin this API is served from, e.g. `https://pbx.example.com`.
	 *
	 * Required to send MMS and for nothing else. The carrier does not accept media bytes — it fetches
	 * them from a URL — so an outbound MMS has to present an absolute link that the carrier's network
	 * can resolve. There is no way to derive that from a request: the send happens on a background
	 * worker with no request to derive it from, and even on a request path an origin taken from a
	 * `Host` header is an origin an attacker chooses.
	 *
	 * Absent means SMS works and an MMS fails with a readable reason naming this variable, which is
	 * better than handing the carrier a relative path it silently cannot fetch.
	 */
	MESSAGING_PUBLIC_BASE_URL: z.url().optional(),

	/**
	 * Ceiling on one MMS part, in bytes.
	 *
	 * The carriers cap MMS at around 1–2 MB after transcoding, so five is generous. The cap exists
	 * for the reason the fax download cap does: an inbound media URL comes out of a webhook body,
	 * and the signature authenticates the WEBHOOK rather than the arbitrary URL inside it.
	 */
	MESSAGING_MAX_MEDIA_BYTES: z.coerce
		.number()
		.int()
		.min(1_024)
		.max(50 * 1_024 * 1_024)
		.default(5 * 1_024 * 1_024),
});

export type MessagingEnv = z.infer<typeof messagingEnvSchema>;

/** Whether messaging is configured at all. Read by the endpoints, never by `main.ts` — see below. */
export function isMessagingConfigured(source: NodeJS.ProcessEnv = process.env): boolean {
	return source.MESSAGING_DRIVER !== undefined && source.MESSAGING_DRIVER !== "none";
}

export function loadMessagingEnv(source: NodeJS.ProcessEnv = process.env): MessagingEnv {
	const parsed = messagingEnvSchema.safeParse(source);
	if (!parsed.success) {
		const detail = parsed.error.issues
			.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("; ");
		throw new Error(`Invalid messaging environment — ${detail}`);
	}
	return parsed.data;
}
