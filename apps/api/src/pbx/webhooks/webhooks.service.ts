import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { PbxResourceService } from "../shared/pbx-resource.service";
import { PBX_EFFECT_RUNTIME, PBX_ENV } from "../shared/pbx.tokens";
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
 */
@Injectable()
export class WebhooksService extends PbxResourceService {
	constructor(
		@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime,
		@Inject(PBX_ENV) private readonly env: PbxEnv,
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
		const created = await super.create(session, { ...values, secret });
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
		return await super.update(session, id, { ...values, ...revived });
	}
}
