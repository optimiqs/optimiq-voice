import { Inject, Injectable } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logger";
import { resolveSettings } from "../catalog/cascade";
import { modelDefaults, templateFor } from "../catalog/catalog";
import { renderWith } from "../catalog/template";
import { softphonePayload } from "../catalog/templates/softphone";
import { isRenderConfigured } from "../provisioning-env";
import { PROVISIONING_ENV } from "../provisioning.tokens";
import { ProvisioningRateLimiter } from "./provision-rate-limit";
import { deriveSipPassword } from "./provision-secret";
import {
	parseProvisioningToken,
	provisioningPayloadUrl,
	secretMatchesHash,
} from "./provision-token";
import {
	ProvisionRateLimitedException,
	ProvisionRefusedException,
	type ProvisionRejectReason,
} from "./provision.errors";
import { ProvisionEventPublisher } from "./provision.publisher";
import { ProvisionRepository } from "./provision.repository";
import type {
	RenderContext,
	RenderKey,
	RenderLine,
	RenderedConfig,
} from "../catalog/render-context";
import type { VendorTemplate } from "../catalog/template";
import type { SoftphonePayload } from "../catalog/templates/softphone";
import type { ProvisioningEnv } from "../provisioning-env";
import type { RenderSnapshot, TokenLookup } from "./provision.repository";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

/**
 * The render path: a phone's token in, a configuration out.
 *
 * ## The order of the checks is the design
 *
 * FusionPBX resolved a device by MAC, User-Agent or source IP over an **unauthenticated** HTTP
 * endpoint — `plans/reference/fusionpbx-inventory.md` §7 names it the single highest-risk item in
 * the upstream product, and rightly: anyone who could reach the provisioning port and guess a MAC
 * got that extension's SIP password. Every step below exists to make that impossible, and their
 * ORDER matters as much as their presence:
 *
 * 1. **Parse.** A malformed token never reaches the database. This is not security, it is what
 *    keeps a 4 KB path segment out of a query.
 * 2. **Resolve the reference.** One indexed equality on `adminDb`, five columns. This is the only
 *    untenanted read in the area and it is what turns "a phone" into "a tenant".
 * 3. **Verify the secret, in constant time.** Everything before this point is public knowledge;
 *    everything after it is authenticated.
 * 4. **Expiry.**
 * 5. **Rate limit** — deliberately AFTER authentication. A limiter consulted before it would let an
 *    unauthenticated caller exhaust a real device's budget and lock its phone out by guessing its
 *    reference, which is a denial of service handed out for free.
 * 6. **Device and organization state.**
 * 7. **Source-address allowlist**, when the organization has one.
 * 8. **Deployment configuration** — after all of the above, so an anonymous prober never learns
 *    which variables this deployment is missing.
 * 9. **Render.**
 *
 * Steps 3 through 8 all answer the caller with the SAME 404. See `provision.errors.ts` for why, and
 * for where the real reason goes instead.
 *
 * ## Nothing here is Effect, and that is deliberate
 *
 * The PBX area's repository is an Effect service because it is a declarative CRUD engine whose
 * failures are a closed algebra mapped onto HTTP. This path is neither: it has no session, its
 * failures are one refusal plus one rate limit, and its data access is four queries. A second
 * `ModuleEffectRuntime` and a second failure algebra would be ceremony over `if` statements. The
 * area's own precedent is `pbx/carrier/carrier.service.ts`, which is a plain `@Injectable()` for
 * the same reason.
 */
@Injectable()
export class ProvisionService {
	constructor(
		@Inject(ProvisionRepository) private readonly repository: ProvisionRepository,
		@Inject(ProvisionEventPublisher) private readonly events: ProvisionEventPublisher,
		@Inject(PROVISIONING_ENV) private readonly env: ProvisioningEnv,
		@Inject(ProvisioningRateLimiter) private readonly limiter: ProvisioningRateLimiter,
	) {}

	/** The vendor-format configuration a desk phone fetches. */
	async renderConfig(request: ProvisionRequest): Promise<ProvisionResult<RenderedConfig>> {
		const { context, template } = await this.authorizeAndBuild(request);
		return { value: renderWith(template, context), context, templateId: template.id };
	}

	/**
	 * The structured account payload a softphone (or a QR code) consumes.
	 *
	 * Deliberately available for EVERY vendor, not only `softphone`: the same fields are what an
	 * administrator needs when a desk phone will not provision and they have to type an account in by
	 * hand. It is the same authorization path and the same credential, so restricting it by vendor
	 * would buy no security and would remove the one escape hatch a broken template leaves.
	 */
	async renderPayload(request: ProvisionRequest): Promise<ProvisionResult<SoftphonePayload>> {
		const { context, template } = await this.authorizeAndBuild(request);
		return { value: softphonePayload(context), context, templateId: template.id };
	}

	// -------------------------------------------------------------------------------------------

	private async authorizeAndBuild(
		request: ProvisionRequest,
	): Promise<{ readonly context: RenderContext; readonly template: VendorTemplate }> {
		// --- 1. parse ----------------------------------------------------------------------------
		const parsed = parseProvisioningToken(request.token);
		if (parsed === undefined) {
			// No tenant is known, so nothing can be published. Logged at `warn`, which is where a
			// platform operator watches for enumeration.
			logger.warn("provisioning request with an unparsable token", {
				sourceAddress: request.sourceAddress,
				path: request.path,
			});
			throw new ProvisionRefusedException({ reason: "missing-token" });
		}

		// --- 2. resolve the reference (the one untenanted read) -----------------------------------
		const found = await this.repository.findByTokenReference(parsed.reference);
		if (found === undefined) {
			logger.warn("provisioning request for an unknown token reference", {
				sourceAddress: request.sourceAddress,
				path: request.path,
				userAgent: request.userAgent,
			});
			throw new ProvisionRefusedException({ reason: "invalid-token" });
		}

		// --- 3. verify the secret ------------------------------------------------------------------
		if (!verifySecret(found, parsed.secret)) {
			await this.reject(request, found, "invalid-token", "secret mismatch");
			throw new ProvisionRefusedException({
				reason: "invalid-token",
				organizationId: found.organizationId,
				deviceId: found.id,
			});
		}

		// From here the caller is authenticated, so every rejection is publishable against a tenant.
		await this.events.publish("device.requested", found.organizationId, {
			sourceAddress: request.sourceAddress,
			...(request.path === undefined ? {} : { path: request.path }),
			...(request.userAgent === undefined ? {} : { userAgent: request.userAgent }),
			macAddress: found.macAddress,
			vendor: found.vendor,
			...(found.model === null ? {} : { model: found.model }),
		});

		// --- 4. expiry ------------------------------------------------------------------------------
		if (
			found.provisioningTokenExpiresAt !== null &&
			found.provisioningTokenExpiresAt <= new Date()
		) {
			await this.reject(request, found, "invalid-token", "token expired");
			throw new ProvisionRefusedException({ reason: "invalid-token", ...identify(found) });
		}

		// --- 5. rate limit (after authentication — see the class comment) ---------------------------
		const verdict = this.limiter.consume(parsed.reference);
		if (!verdict.allowed) {
			await this.reject(request, found, "rate-limited", `retry in ${verdict.retryAfterSeconds}s`);
			throw new ProvisionRateLimitedException(
				verdict.retryAfterSeconds,
				found.organizationId,
				found.id,
			);
		}

		// --- 6. device state -------------------------------------------------------------------------
		if (!found.enabled) {
			await this.reject(request, found, "disabled", "device disabled");
			throw new ProvisionRefusedException({ reason: "disabled", ...identify(found) });
		}

		// --- 7. source-address allowlist ------------------------------------------------------------
		const allowlist = await this.repository.checkAllowlist(
			found.organizationId,
			request.sourceIp ?? "",
		);
		const allowlistApplies = allowlist.hasEntries || this.env.PROVISION_REQUIRE_IP_ALLOWLIST;
		if (allowlistApplies && !allowlist.allowed) {
			await this.reject(
				request,
				found,
				"ip-not-allowed",
				allowlist.hasEntries
					? `no allow entry matched ${request.sourceIp ?? "an unknown address"}`
					: "PROVISION_REQUIRE_IP_ALLOWLIST is set and this organization has no allow entries",
			);
			throw new ProvisionRefusedException({ reason: "ip-not-allowed", ...identify(found) });
		}

		// --- 8. deployment configuration --------------------------------------------------------------
		if (!isRenderConfigured(this.env)) {
			await this.reject(
				request,
				found,
				"not-configured",
				"deployment has no SIP server or secret key",
			);
			throw new ProvisionRefusedException({ reason: "not-configured", ...identify(found) });
		}

		// --- 9. render ----------------------------------------------------------------------------
		const snapshot = await this.repository.loadSnapshot(found.organizationId, found.id);
		if (snapshot === undefined) {
			// The row vanished between the untenanted lookup and the tenant-scoped read — a delete that
			// landed in the microsecond between them. Indistinguishable from an unknown token to the
			// caller, which is correct, and worth its own log line because it is otherwise inexplicable.
			await this.reject(request, found, "invalid-token", "device disappeared between reads");
			throw new ProvisionRefusedException({ reason: "invalid-token", ...identify(found) });
		}

		const template = templateFor(found.vendor);
		if (template === undefined) {
			await this.reject(request, found, "unknown-vendor", `no template for ${found.vendor}`);
			throw new ProvisionRefusedException({ reason: "unknown-vendor", ...identify(found) });
		}

		const context = this.buildContext(found.organizationId, snapshot, request.token);
		return { context, template };
	}

	/**
	 * Turns the database snapshot into the pure value the templates consume.
	 *
	 * Everything that needs the environment, the clock or the key derivation happens here, so a
	 * template stays a function of its input and a golden assertion over one stays meaningful.
	 */
	private buildContext(
		organizationId: string,
		snapshot: RenderSnapshot,
		token: string,
	): RenderContext {
		const sipServer = this.env.PROVISION_SIP_SERVER as string;
		const rootKey = this.env.PROVISION_SIP_SECRET_KEY as string;

		const lines: RenderLine[] = [];
		for (const row of snapshot.lines) {
			if (!row.line.enabled) {
				continue;
			}
			/**
			 * A line with no resolvable identity is SKIPPED rather than rendered empty.
			 *
			 * `device_line.extension_id` is `ON DELETE SET NULL`, so deleting an extension leaves its
			 * device lines behind pointing at nothing. Rendering `account.2.user_name = ` would give
			 * the phone a half-configured account it retries forever; omitting the account entirely
			 * leaves the key dark, which is what an unassigned line key should look like. Nothing
			 * shifts, because every template writes the account under its own `lineNumber`.
			 */
			const registerUser = row.extension?.number ?? row.line.authUser ?? undefined;
			const secretRef = row.extension?.sipSecretRef ?? row.line.sipSecretRef ?? undefined;
			if (registerUser === undefined || secretRef === undefined) {
				logger.warn("skipping a device line with no resolvable SIP identity", {
					organizationId,
					deviceId: snapshot.device.id,
					lineNumber: row.line.lineNumber,
				});
				continue;
			}

			lines.push({
				lineNumber: row.line.lineNumber,
				displayName: row.extension?.callerIdName ?? row.extension?.label ?? registerUser,
				registerUser,
				authUser: row.line.authUser ?? registerUser,
				password: deriveSipPassword({ rootKey, organizationId, secretRef }),
				serverAddress: row.line.serverAddress ?? sipServer,
				serverPort: row.line.serverPort,
				transport: row.line.transport,
				outboundProxy: this.env.PROVISION_SIP_OUTBOUND_PROXY,
				registerExpiresSeconds: row.line.registerExpiresSeconds,
				sharedLine: row.line.sharedLine,
				label: row.line.label ?? undefined,
				/**
				 * The mailbox number is the extension number.
				 *
				 * `voicemail_box` carries a `mailboxNumber` of its own, and reading it would mean a
				 * fifth join for a value that is the extension number in every deployment this product
				 * creates one for. When mailbox numbers become independently assignable the join comes
				 * with them; until then the join would be a lookup whose answer is already in hand.
				 */
				voicemailNumber: row.extension?.voicemailEnabled === true ? registerUser : undefined,
			});
		}

		return {
			organizationId,
			deviceId: snapshot.device.id,
			macAddress: snapshot.device.macAddress,
			vendor: snapshot.device.vendor,
			model: snapshot.device.model ?? undefined,
			label: snapshot.device.label ?? undefined,
			lines,
			keys: mergeKeys(snapshot),
			settings: resolveSettings({
				model: modelDefaults(snapshot.device.vendor),
				organization: snapshot.organizationSettings,
				profile: snapshot.profile?.settings,
				device: snapshot.device.settings,
			}),
			sipDomain: sipServer,
			payloadUrl:
				this.env.PROVISION_BASE_URL === undefined
					? undefined
					: provisioningPayloadUrl(this.env.PROVISION_BASE_URL, token),
			renderedAt: new Date(),
		};
	}

	/**
	 * Records the render: the device's check-in columns and the `device.rendered` event.
	 *
	 * Called by the controller AFTER the body has been produced, and both halves are best-effort:
	 * the configuration is already correct and already on its way, so failing the response because
	 * an audit write did not land would turn an observability problem into an outage on the path
	 * that brings a phone back to life after a power cut.
	 */
	async recordRender(
		request: ProvisionRequest,
		context: RenderContext,
		templateId: string,
		bytes: number,
	): Promise<void> {
		try {
			await this.repository.recordProvisioned(
				context.organizationId,
				context.deviceId,
				request.sourceIp,
			);
		} catch (error) {
			logger.error("could not record a provisioning check-in", {
				organizationId: context.organizationId,
				deviceId: context.deviceId,
				error,
			});
		}

		await this.events.publish("device.rendered", context.organizationId, {
			sourceAddress: request.sourceAddress,
			...(request.path === undefined ? {} : { path: request.path }),
			...(request.userAgent === undefined ? {} : { userAgent: request.userAgent }),
			macAddress: context.macAddress,
			vendor: context.vendor,
			// The schema requires a model; `unknown` is the honest value for a device whose model an
			// administrator did not record, and is preferable to omitting a required field.
			model: context.model ?? "unknown",
			deviceId: context.deviceId,
			templateId,
			bytes,
		});
	}

	/** One rejection: the log line and the event, never the response body. */
	private async reject(
		request: ProvisionRequest,
		found: TokenLookup,
		reason: ProvisionRejectReason,
		detail: string,
	): Promise<void> {
		logger.warn("provisioning request refused", {
			reason,
			detail,
			organizationId: found.organizationId,
			deviceId: found.id,
			macAddress: found.macAddress,
			sourceAddress: request.sourceAddress,
			userAgent: request.userAgent,
		});
		await this.events.publish("device.rejected", found.organizationId, {
			sourceAddress: request.sourceAddress,
			...(request.path === undefined ? {} : { path: request.path }),
			...(request.userAgent === undefined ? {} : { userAgent: request.userAgent }),
			macAddress: found.macAddress,
			reason,
			detail,
		} as never);
	}
}

/** A render, plus what the caller needs to record it. */
export interface ProvisionResult<T> {
	readonly value: T;
	readonly context: RenderContext;
	readonly templateId: string;
}

export interface ProvisionRequest {
	readonly token: string;
	/** `host:port` — always known, it is the transport peer. */
	readonly sourceAddress: string;
	/** Just the host part, for the ACL check. */
	readonly sourceIp: string | undefined;
	readonly path: string | undefined;
	readonly userAgent: string | undefined;
}

/**
 * Whether a presented secret authenticates this row.
 *
 * Two shapes are accepted and they do not overlap:
 *
 * - **Split token** (`<reference>.<secret>`) against a row with a hash. The only shape a device
 *   minted by this build has.
 * - **Legacy token** (no separator) against a row WITHOUT a hash. The compatibility window for rows
 *   written before the split, and it closes for a device the moment somebody rotates it — a
 *   rotation writes a hash, and a row with a hash refuses the legacy shape outright.
 *
 * A split token presented against a legacy row fails, and a legacy token presented against a
 * rotated row fails. Neither can be made to work by an attacker who holds the other, which is the
 * property that makes shipping the compatibility window safe.
 */
function verifySecret(found: TokenLookup, secret: string | undefined): boolean {
	if (found.provisioningTokenHash !== null) {
		return secret !== undefined && secretMatchesHash(secret, found.provisioningTokenHash);
	}
	// The legacy row's whole token IS the reference, and the lookup that produced this row was an
	// equality on it — so there is nothing left to compare. What has to be enforced is that the
	// caller presented the legacy SHAPE: a split token whose reference happened to collide with a
	// legacy plaintext value must not be accepted on the strength of a half it never proved.
	return secret === undefined;
}

function identify(found: TokenLookup): {
	readonly organizationId: string;
	readonly deviceId: string;
	readonly macAddress: string;
} {
	return {
		organizationId: found.organizationId,
		deviceId: found.id,
		macAddress: found.macAddress,
	};
}

/**
 * The profile's keys, overridden by the device's, keyed by `(category, keyIndex)`.
 *
 * Override rather than merge, and by the pair rather than by the index alone: memory key 3 and line
 * key 3 are different buttons, and a device that sets memory key 3 must not silently take over the
 * profile's line key 3. A device key with `keyType: "none"` is an override too — it is how an
 * administrator says "this phone does not have the profile's BLF key here", and dropping it would
 * make that unexpressible.
 */
function mergeKeys(snapshot: RenderSnapshot): readonly RenderKey[] {
	const merged = new Map<string, RenderKey>();
	for (const key of snapshot.profileKeys) {
		merged.set(`${key.category}:${key.keyIndex}`, toRenderKey(key));
	}
	for (const key of snapshot.keys) {
		merged.set(`${key.category}:${key.keyIndex}`, toRenderKey(key));
	}
	return [...merged.values()].sort(
		(a, b) => a.category.localeCompare(b.category) || a.keyIndex - b.keyIndex,
	);
}

function toRenderKey(row: {
	readonly category: RenderKey["category"];
	readonly keyIndex: number;
	readonly keyType: RenderKey["keyType"];
	readonly value: string | null;
	readonly label: string | null;
	readonly lineNumber: number;
}): RenderKey {
	return {
		category: row.category,
		keyIndex: row.keyIndex,
		keyType: row.keyType,
		value: row.value ?? undefined,
		label: row.label ?? undefined,
		lineNumber: row.lineNumber,
	};
}
