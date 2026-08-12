import { z } from "zod/v4";

/**
 * The fax slice's environment contract.
 *
 * Small and self-contained, like `carrier-env.ts`, rather than folded into `pbx-env.ts`: fax adds a
 * store root, a send-worker cadence and a link-signing secret, and none of them mean anything to the
 * rest of the telephony area. Keeping them here is what lets a deployment run every other PBX
 * endpoint with no fax configuration at all — the send worker simply does not arm, and the
 * fax-to-email link is omitted, exactly the way the carrier key's absence degrades number ordering.
 *
 * `zod/v4` for the reason `carrier-env.ts` states: `apps/api` still pins `zod@3.25.76` for legacy
 * files, and 3.25 ships the whole Zod 4 implementation under that subpath.
 */
export const faxEnvSchema = z.object({
	/** Where fax documents (received and outbound sources) are stored. */
	FAX_OBJECT_ROOT: z.string().min(1).default("./.data/faxes"),

	/**
	 * The Telnyx Programmable Fax connection / Fax Application id every outbound fax is sent from.
	 *
	 * Platform-level, like `TELNYX_API_KEY` — one fax application bills to the platform account.
	 * Absent means outbound sending is unavailable and a queued fax fails with a readable reason
	 * rather than being retried forever; inbound and CRUD are unaffected.
	 */
	TELNYX_FAX_CONNECTION_ID: z.string().min(1).optional(),

	/**
	 * The outbound send worker's master switch, under the same reasoning `CDR_WRITER_ENABLED` uses:
	 * it is a singleton-shaped workload and an operator wants it in one place, though N replicas would
	 * still be correct because the claim is a `skip locked` compare-and-set.
	 */
	FAX_SEND_ENABLED: z
		.stringbool({ truthy: ["true", "1"], falsy: ["false", "0", ""] })
		.default(true),

	/** Send-queue poll interval. `0` disables the worker without disabling the API. */
	FAX_SEND_POLL_INTERVAL_MS: z.coerce.number().int().min(0).max(3_600_000).default(5_000),

	/**
	 * How long a claimed but unfinished send may sit before another pass reclaims it. The lease that
	 * unsticks a row a crashed worker left in `sending`.
	 */
	FAX_SEND_LEASE_MS: z.coerce.number().int().min(30_000).max(86_400_000).default(120_000),

	/**
	 * The secret that signs fax-to-email media links. Absent = no link is minted and the notification
	 * goes out with the metadata and an in-app inbox link alone, exactly as voicemail degrades without
	 * `PBX_VOICEMAIL_URL_SECRET`.
	 */
	FAX_MEDIA_URL_SECRET: z.string().min(1).optional(),

	/** Lifetime of a minted fax media link, in seconds. */
	FAX_MEDIA_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(86_400).default(3_600),
});

export type FaxEnv = z.infer<typeof faxEnvSchema>;

export function loadFaxEnv(source: NodeJS.ProcessEnv = process.env): FaxEnv {
	const parsed = faxEnvSchema.safeParse(source);
	if (!parsed.success) {
		const detail = parsed.error.issues
			.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("; ");
		throw new Error(`Invalid fax environment — ${detail}`);
	}
	return parsed.data;
}
