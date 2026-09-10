import { Inject, Injectable } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { formatDispatchableLocation } from "../../mail";
import { SipAuthEventService } from "../../pbx/security/sip-auth-event.service";
import { resolveSettings } from "../catalog/cascade";
import { modelDefaults, templateFor } from "../catalog/catalog";
import { renderWith } from "../catalog/template";
import { softphonePayload } from "../catalog/templates/softphone";
import { resolveLinePort, resolveLineTransport } from "../catalog/transport-preference";
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
	DispatchableLocation,
	RenderContext,
	RenderKey,
	RenderLine,
	RenderedConfig,
} from "../catalog/render-context";
import type { VendorTemplate } from "../catalog/template";
import type { SoftphonePayload } from "../catalog/templates/softphone";
import type { ConfiguredProvisioningEnv, ProvisioningEnv } from "../provisioning-env";
import type { RenderSnapshot, TokenLookup } from "./provision.repository";
import type { SipAuthEventType } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.provisioning");

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
 * 3. **Rate limit**, keyed on the resolved reference. It has to come BEFORE the secret comparison,
 *    because every step after this one writes: a refusal publishes `device.rejected` and files an
 *    `sip_auth_event` row. A limiter consulted after authentication is a limiter a caller holding
 *    only the (non-secret, plaintext-stored) reference walks straight past, driving unbounded
 *    inserts and broker publishes from an unauthenticated endpoint. The cost of this order is that
 *    such a caller can also exhaust a real device's one-minute budget; a phone that re-polls after
 *    the window is the price of not handing out an unbounded write.
 * 4. **Verify the secret, in constant time.** Everything before this point is public knowledge;
 *    everything after it is authenticated.
 * 5. **Expiry.**
 * 6. **Device and organization state.**
 * 7. **Source-address allowlist**, when the organization has one.
 * 8. **Deployment configuration** — after all of the above, so an anonymous prober never learns
 *    which variables this deployment is missing.
 * 9. **Render.**
 *
 * Steps 4 through 8 all answer the caller with the SAME 404. See `provision.errors.ts` for why, and
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
		@Inject(SipAuthEventService) private readonly authEvents: SipAuthEventService,
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
			logger.warn(
				{
					sourceAddress: request.sourceAddress,
					path: request.path,
				},
				"provisioning request with an unparsable token",
			);
			throw new ProvisionRefusedException({ reason: "missing-token" });
		}

		// --- 2. resolve the reference (the one untenanted read) -----------------------------------
		const found = await this.repository.findByTokenReference(parsed.reference);
		if (found === undefined) {
			logger.warn(
				{
					sourceAddress: request.sourceAddress,
					path: request.path,
					userAgent: request.userAgent,
				},
				"provisioning request for an unknown token reference",
			);
			throw new ProvisionRefusedException({ reason: "invalid-token" });
		}

		// --- 3. rate limit (before the secret comparison — see the class comment) -------------------
		const verdict = this.limiter.consume(parsed.reference);
		if (!verdict.allowed) {
			// Only the request that crossed the limit is recorded. Filing one every time would make the
			// limiter the source of the unbounded writes it exists to stop.
			if (verdict.firstRefusal) {
				await this.reject(request, found, "rate-limited", `retry in ${verdict.retryAfterSeconds}s`);
			}
			throw new ProvisionRateLimitedException(
				verdict.retryAfterSeconds,
				found.organizationId,
				found.id,
			);
		}

		// --- 4. verify the secret ------------------------------------------------------------------
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

		// --- 5. expiry ------------------------------------------------------------------------------
		if (
			found.provisioningTokenExpiresAt !== null &&
			found.provisioningTokenExpiresAt <= new Date()
		) {
			await this.reject(request, found, "invalid-token", "token expired");
			throw new ProvisionRefusedException({ reason: "invalid-token", ...identify(found) });
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
				allowlist.evaluable
					? allowlist.hasEntries
						? `no allow entry matched ${request.sourceIp ?? "an unknown address"}`
						: "PROVISION_REQUIRE_IP_ALLOWLIST is set and this organization has no allow entries"
					: `the source address ${request.sourceIp ?? "(none)"} is not an IP the ACL can be evaluated against`,
			);
			throw new ProvisionRefusedException({ reason: "ip-not-allowed", ...identify(found) });
		}

		// --- 8. deployment configuration --------------------------------------------------------------
		// Narrowed into a local, because `isRenderConfigured` is a type predicate and a predicate over
		// `this.env` does not survive the call into `buildContext`.
		const env = this.env;
		if (!isRenderConfigured(env)) {
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

		/**
		 * The organization's own SIP domain — `org_setting sip/realm` — and there is NO deployment
		 * default for it (see {@link buildContext}). A tenant that has configured none is refused
		 * rather than rendered against another tenant's realm.
		 */
		const sipDomain =
			typeof snapshot.sipRealm === "string" ? snapshot.sipRealm.trim().toLowerCase() : "";
		if (sipDomain === "") {
			await this.reject(request, found, "not-configured", "SIP domain not configured");
			throw new ProvisionRefusedException({ reason: "not-configured", ...identify(found) });
		}

		const context = this.buildContext(
			env,
			found.organizationId,
			snapshot,
			request.token,
			sipDomain,
		);
		return { context, template };
	}

	/**
	 * Turns the database snapshot into the pure value the templates consume.
	 *
	 * Everything that needs the environment, the clock or the key derivation happens here, so a
	 * template stays a function of its input and a golden assertion over one stays meaningful.
	 */
	private buildContext(
		env: ConfiguredProvisioningEnv,
		organizationId: string,
		snapshot: RenderSnapshot,
		token: string,
		sipDomain: string,
	): RenderContext {
		/**
		 * The AOR domain, and it is the TENANT's — never the deployment's.
		 *
		 * `PROVISION_SIP_SERVER` names the SIP edge a packet is sent TO, which is legitimately
		 * deployment-wide and is still the fallback for `serverAddress` below. The domain an account
		 * registers INTO is a per-tenant claim: `sip_credentials.service.ts` maps one realm to exactly
		 * one organization, so handing an organization that configured none the deployment default
		 * hands it a realm that resolves to a DIFFERENT tenant, and the phone can never register.
		 * `renderFor` resolves and refuses it, so it arrives here already checked.
		 */
		const rootKey = env.PROVISION_SIP_SECRET_KEY;

		/**
		 * The settings cascade, resolved ONCE and before the lines.
		 *
		 * It has to come first because the organization's transport preference is one of the values a
		 * line reads (`catalog/transport-preference.ts`), and because resolving it per line would run
		 * the same four-level merge once per account for an identical answer.
		 */
		const settings = resolveSettings({
			model: modelDefaults(snapshot.device.vendor),
			organization: snapshot.organizationSettings,
			profile: snapshot.profile?.settings,
			device: snapshot.device.settings,
		});

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
				logger.warn(
					{
						organizationId,
						deviceId: snapshot.device.id,
						lineNumber: row.line.lineNumber,
					},
					"skipping a device line with no resolvable SIP identity",
				);
				continue;
			}

			lines.push({
				lineNumber: row.line.lineNumber,
				displayName: row.extension?.callerIdName ?? row.extension?.label ?? registerUser,
				registerUser,
				authUser: row.line.authUser ?? registerUser,
				password: deriveSipPassword({ rootKey, organizationId, secretRef }),
				serverAddress: row.line.serverAddress ?? env.PROVISION_SIP_SERVER,
				/**
				 * The port and the transport, after the organization's preference.
				 *
				 * Both default to the line's own column, so a deployment that has set neither setting
				 * renders exactly what it rendered before the preference existed — which is the whole
				 * migration story: a fleet of provisioned phones must not change behaviour on its next
				 * reprovision because a feature landed.
				 */
				serverPort: resolveLinePort(settings, row.line.serverPort),
				transport: resolveLineTransport(settings, row.line.transport),
				outboundProxy: this.env.PROVISION_SIP_OUTBOUND_PROXY,
				registerExpiresSeconds: row.line.registerExpiresSeconds,
				/**
				 * Shared line, from the rows and no longer from the flag alone.
				 *
				 * `device_line.shared_line` is the manual override an administrator can still tick, but the
				 * fact that decides a shared line is the APPEARANCE: an extension that is an enabled
				 * appearance on an enabled shared line renders `shared_line` true whether or not anyone set
				 * the column. `snapshot.sharedLineExtensionIds` is the membership the repository loaded for
				 * exactly this device's line extensions, so the OR is a set lookup, not a re-query.
				 */
				sharedLine:
					row.line.sharedLine ||
					(row.line.extensionId !== null &&
						snapshot.sharedLineExtensionIds.has(row.line.extensionId)),
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
			settings,
			sipDomain,
			dispatchableLocation: dispatchableLocationOf(snapshot),
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
			logger.error(
				{
					organizationId: context.organizationId,
					deviceId: context.deviceId,
					error,
				},
				"could not record a provisioning check-in",
			);
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
		logger.warn(
			{
				reason,
				detail,
				organizationId: found.organizationId,
				deviceId: found.id,
				macAddress: found.macAddress,
				sourceAddress: request.sourceAddress,
				userAgent: request.userAgent,
			},
			"provisioning request refused",
		);
		await this.events.publish("device.rejected", found.organizationId, {
			sourceAddress: request.sourceAddress,
			...(request.path === undefined ? {} : { path: request.path }),
			...(request.userAgent === undefined ? {} : { userAgent: request.userAgent }),
			macAddress: found.macAddress,
			reason,
			detail,
		} as never);

		/**
		 * And into the attack log, when the refusal is one.
		 *
		 * This is the one seam in the whole API that already has everything the ledger needs — the
		 * tenant, the reason, the source address and the identity that was attempted — which is why
		 * the recording hangs here rather than at each of the eight `throw` sites above.
		 *
		 * `authEventTypeFor` returns `undefined` for the refusals that are NOT authentication
		 * failures, and that filter is the point. `not-configured` is a deployment missing a
		 * variable; `unknown-vendor` is a template gap. Filing either as an attack would put the
		 * platform's own misconfiguration into the feed an operator scans for intrusions and reads
		 * source addresses out of, which is how a security log becomes noise nobody looks at.
		 *
		 * Awaited, and it cannot fail: `SipAuthEventService.record` swallows and logs its own errors
		 * so that a database problem during an attack cannot change the refusal the caller receives.
		 */
		const eventType = authEventTypeFor(reason);
		if (eventType !== undefined) {
			await this.authEvents.record({
				organizationId: found.organizationId,
				eventType,
				scope: "provisioning",
				sourceIp: request.sourceIp,
				// The MAC, not the token or any part of it: this column names WHO was attempted, and a
				// token is a credential. `security-schema.ts` states the rule.
				accountRef: found.macAddress,
				transport: "https",
				userAgent: request.userAgent,
				detail: { reason, detail, deviceId: found.id, path: request.path ?? null },
			});
		}
	}
}

/**
 * Which refusals are authentication failures, and which are ours.
 *
 * The mapping is deliberately partial. Only four of the nine reasons describe something a CALLER
 * did wrong in a way a security responder would want to see; the rest describe the state of this
 * deployment, and `security-schema.ts` explains why mixing the two ruins the feed.
 *
 * `missing-token` and `unknown-mac` are absent for a different reason again — they are raised
 * before a tenant is known, so there is no organization to file the row under and no `reject` call
 * to reach this function. Those get the `warn` log lines above, which is what a platform operator
 * watches for enumeration.
 */
function authEventTypeFor(reason: ProvisionRejectReason): SipAuthEventType | undefined {
	switch (reason) {
		case "invalid-token":
			return "token-invalid";
		case "rate-limited":
			return "rate-limited";
		case "ip-not-allowed":
			return "acl-denied";
		case "disabled":
			// A disabled device whose token still works is a credential that outlived its authorisation,
			// which is precisely the case an attack log exists to surface — and precisely why it is not
			// filed as `unknown-account`. See the type's own note.
			return "disabled-account";
		default:
			return undefined;
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

/**
 * The handset's dispatchable location, or `undefined` when it has none.
 *
 * A device carrying only a `location_detail` and no address contributes nothing here, and that is
 * deliberate: "Desk 12" is not a dispatchable location, it is a refinement of one, and rendering it
 * alone would put a fragment in front of somebody who needs a street. The number-level fallback
 * still applies at notification time (`emergency-notification.service.ts` joins the two), which is
 * the only place both facts are in hand.
 *
 * `formatDispatchableLocation` is the mail area's helper and is reused rather than reimplemented so
 * the address a user reads in the softphone is character-for-character the one a responder is read
 * off the Kari's Law notification. Two formatters would drift, and the drift would be discovered by
 * somebody comparing them during an incident.
 */
function dispatchableLocationOf(snapshot: RenderSnapshot): DispatchableLocation | undefined {
	const address = snapshot.emergencyAddress;
	if (address === undefined) {
		return undefined;
	}
	const formatted = formatDispatchableLocation(address, snapshot.device.emergencyLocationDetail);
	if (formatted.length === 0) {
		return undefined;
	}
	return {
		addressId: address.id,
		formatted,
		detail: snapshot.device.emergencyLocationDetail,
		validated: address.validated,
	};
}
