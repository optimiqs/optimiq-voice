import { BadRequestException, Inject, Injectable, Optional } from "@nestjs/common";
import { encryptSecret, requireSecretKey } from "@optimiq-voice/db";
import { PbxResourceService } from "../shared/pbx-resource.service";
import { PBX_EFFECT_RUNTIME, PBX_ENV } from "../shared/pbx.tokens";
import { WebhookDispatcher } from "./webhook-dispatcher.service";
import { generateWebhookSecret } from "./webhook-signature";
import { WEBHOOK_SUBSCRIPTION_RESOURCE } from "./webhooks.resource";
import type { PbxEnv } from "../shared/pbx-env";
import type { MutationEnvelope } from "../shared/pbx-resource.service";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * Webhook subscriptions.
 *
 * Two overrides on top of the generic CRUD, and both exist because a signing key is not an ordinary
 * column.
 *
 * ## `create` mints a secret and returns it EXACTLY once
 *
 * The DTO makes `secret` optional so an administrator using the UI does not have to invent 256 bits
 * of entropy; when it is absent one is generated here. Whichever way it arrived, the created row is
 * returned with the secret ON it — the one place in this area where a `secretColumns` value crosses
 * the boundary — because the whole point of the value is to be pasted into the receiving system, and
 * a key nobody can read is a subscription nobody can verify.
 *
 * It is written down rather than assumed: this is the ONLY response that carries it. `list`, `get`
 * and `update` all go through the generic redaction, so a secret that was not copied at creation
 * time is unrecoverable and has to be rotated. That is the correct trade — the alternative is an
 * endpoint that hands out every tenant's signing keys to anybody holding `webhooks.read`.
 *
 * ## The stored column is a ciphertext, and only the dispatcher opens it
 *
 * The key cannot be hashed — the platform is the signer — but it can be SEALED, and the envelope
 * built for SSO client secrets is the same shape: a value the platform must present again. Both
 * write paths therefore store `encryptSecret(secret, requireSecretKey())`, so a dump of
 * `webhook_subscription` yields no usable signing key. `requireSecretKey` and not `loadSecretKey`,
 * because a write is the one moment where a missing key can still be fixed without losing anything:
 * failing the request is strictly better than minting a key that lands in the table in the clear.
 *
 * The plaintext returned by `create` is the one below, before sealing — the caller has to receive
 * the value they will configure the far end with, not the envelope around it.
 *
 * ## `update` clears the failure state when a subscription is switched back on
 *
 * An auto-disabled subscription carries a failure count and an `auto_disabled_at`. Re-enabling it
 * without clearing both would arm the auto-disable at the first hiccup after the fix — the counter
 * would still be at its ceiling — so "turn it back on" would produce an endpoint that disables
 * itself again on one bad delivery. Clearing them here makes the obvious recovery a complete one.
 *
 * Done on ENABLE only, not on every update: an administrator editing the selector list of a
 * currently-failing subscription has not fixed anything, and silently resetting the counter would
 * hide the failure they are about to make worse.
 *
 * ## Every mutation invalidates the dispatcher's cache
 *
 * The dispatcher holds a tenant's subscriptions for `PBX_WEBHOOK_CACHE_TTL_MS`. Without this call a
 * DELETED subscription keeps receiving the tenant's call metadata at a URL an administrator just
 * removed, and a ROTATED secret leaves every delivery in the window signed with the retired key.
 * The dispatcher is optional so a spec can construct this service without a broker.
 */
@Injectable()
export class WebhooksService extends PbxResourceService {
	constructor(
		@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime,
		@Inject(PBX_ENV) private readonly env: PbxEnv,
		@Optional() private readonly dispatcher?: WebhookDispatcher,
	) {
		super(runtime, WEBHOOK_SUBSCRIPTION_RESOURCE);
	}

	/**
	 * Refuses a plaintext endpoint unless the deployment has opted in.
	 *
	 * Checked HERE and not in the DTO for one reason: the DTO is a pure schema and cannot read the
	 * environment, and threading a parsed env into every `parseDto` call site so that one field could
	 * consult it would be a much larger change than the rule is worth. The failure is still a 400 with
	 * the field named, which is what a caller needs.
	 *
	 * The rule itself is about CONFIDENTIALITY, and it is worth being precise about why the signature
	 * does not cover it: an HMAC proves a body came from us and was not altered. It does nothing to
	 * stop a hop reading it, and the body is a tenant's call metadata — who called whom, from where,
	 * for how long.
	 */
	private assertUrlAllowed(values: Record<string, unknown>): void {
		const url = values.url;
		if (typeof url !== "string" || this.env.PBX_WEBHOOK_ALLOW_INSECURE_URLS) {
			return;
		}
		if (!/^https:\/\//iu.test(url.trim())) {
			throw new BadRequestException({
				statusCode: 400,
				code: "PBX_INVALID_BODY",
				message: "A webhook endpoint must be https.",
				issues: [
					{
						field: "url",
						code: "insecure",
						message:
							"Only https endpoints are accepted. Set PBX_WEBHOOK_ALLOW_INSECURE_URLS=true to " +
							"allow http in a development deployment.",
					},
				],
			});
		}
	}

	override async create(
		session: AppSession,
		values: Record<string, unknown>,
	): Promise<MutationEnvelope<Record<string, unknown>>> {
		this.assertUrlAllowed(values);
		const secret = typeof values.secret === "string" ? values.secret : generateWebhookSecret();
		const created = await super.create(session, {
			...values,
			secret: encryptSecret(secret, requireSecretKey()),
		});
		this.dispatcher?.invalidate(this.organizationId(session));
		// Re-attached AFTER the generic redaction has run, so the exception is visible here rather
		// than being a hole in `redactRow`.
		return { ...created, data: { ...created.data, secret } };
	}

	override async update(
		session: AppSession,
		id: string,
		values: Record<string, unknown>,
	): Promise<MutationEnvelope<Record<string, unknown>>> {
		this.assertUrlAllowed(values);
		const revived =
			values.enabled === true
				? { consecutiveFailures: 0, lastFailureReason: null, autoDisabledAt: null }
				: {};
		// A rotation arrives here as an ordinary field and has to be sealed exactly as a new one is;
		// every other key on the patch is configuration and is written verbatim.
		const rotated =
			typeof values.secret === "string"
				? { secret: encryptSecret(values.secret, requireSecretKey()) }
				: {};
		const updated = await super.update(session, id, { ...values, ...rotated, ...revived });
		this.dispatcher?.invalidate(this.organizationId(session));
		return updated;
	}

	override async remove(
		session: AppSession,
		id: string,
	): Promise<MutationEnvelope<{ readonly id: string }>> {
		const removed = await super.remove(session, id);
		this.dispatcher?.invalidate(this.organizationId(session));
		return removed;
	}
}
