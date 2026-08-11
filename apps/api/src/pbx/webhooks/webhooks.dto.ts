import { z } from "zod/v4";
import { patchOf } from "../shared/dto";
import { invalidWebhookSelectors } from "./webhook-selectors";

/**
 * A webhook subscription, as an administrator writes it.
 *
 * ## The URL rules, and the one that is a security control
 *
 * The SHAPE is checked here — an absolute http(s) URL with no embedded credentials — and the
 * `https`-only rule is enforced one layer up, in `WebhooksService.assertUrlAllowed`, because it
 * depends on `PBX_WEBHOOK_ALLOW_INSECURE_URLS` and a schema cannot read the environment. Both
 * produce the same 400 with the same field named.
 *
 * Nothing here validates that the host RESOLVES, or that it is not a private address. The second is
 * the interesting omission: an endpoint pointed at `http://169.254.169.254/` is the classic SSRF
 * shape, and blocking it by IP range at write time does not work — DNS is not stable between the
 * check and the delivery, and the delivery is the request that matters. The control that does work
 * belongs in the dispatcher (a fixed method, no redirect following, a short timeout, no response
 * body read), and it is implemented there rather than pretended at here.
 *
 * ## The secret is write-only
 *
 * It may be set on create, replaced on update, and is NEVER returned — `secretColumns` on the
 * resource is the read half of that sentence. Omitting it on create means "generate one", which is
 * what an administrator using the UI will do, and the generated value is returned exactly once in
 * the create response so it can be copied into the receiving system.
 */

/** A subscription's delivery endpoint. Length-capped so a row cannot carry a document. */
const webhookUrl = z
	.string()
	.trim()
	.min(1)
	.max(2048)
	.refine((value) => /^https?:\/\//iu.test(value), "url must be an http(s) URL")
	.refine((value) => {
		try {
			// Parsed rather than pattern-matched, so a URL with credentials or a bad host is refused by
			// the same parser the delivery will use.
			const parsed = new URL(value);
			return parsed.username === "" && parsed.password === "";
		} catch {
			return false;
		}
	}, "url must be a valid absolute URL and must not carry credentials");

/**
 * The events this endpoint wants.
 *
 * At least one: a subscription selecting nothing is an endpoint that never fires, which is a
 * configuration mistake with no symptom. Capped at 32 because the dispatcher matches every selector
 * against every message, and a list longer than the platform's whole event vocabulary is a mistake
 * rather than a requirement.
 */
const webhookSelectors = z
	.array(z.string().trim().min(1).max(128))
	.min(1)
	.max(32)
	.superRefine((value, context) => {
		const invalid = invalidWebhookSelectors(value);
		if (invalid.length > 0) {
			context.addIssue({
				code: "custom",
				message:
					`unknown event selector(s): ${invalid.join(", ")}. Use a family wildcard ` +
					`(\`calls.evt.v1.>\`) or an exact type (\`calls.evt.v1.channel.answered\`).`,
			});
		}
	});

const webhookShape = {
	description: z.string().trim().max(256).nullish(),
	url: webhookUrl,
	/**
	 * The signing key. Optional on create — absent means "generate one" — and settable on update,
	 * which is how a secret is rotated. Never returned.
	 */
	secret: z.string().trim().min(16).max(256).optional(),
	eventSelectors: webhookSelectors,
	/**
	 * Setting this back to `true` is also how an auto-disabled subscription is revived; the service
	 * clears the failure counter and `auto_disabled_at` alongside it.
	 */
	enabled: z.boolean().optional(),
};

export const createWebhookDto = z.strictObject(webhookShape);

/**
 * On PATCH every field is optional, including `eventSelectors` — but a selector list that IS sent is
 * validated in full rather than merged. A partial list would be ambiguous ("add these" or "these
 * now"), and the ambiguity would be discovered as missing deliveries.
 */
export const updateWebhookDto = patchOf(z.strictObject(webhookShape));
