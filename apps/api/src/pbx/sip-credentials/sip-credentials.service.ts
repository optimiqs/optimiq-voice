import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import {
	and,
	asc,
	deviceLine,
	eq,
	extension,
	orgSetting,
	sharedLine,
	sharedLineAppearance,
	sql,
} from "@optimiq-voice/pbx-db";
import { loadProvisioningEnv } from "../../provisioning/provisioning-env";
import { deriveSipPassword } from "../../provisioning/render/provision-secret";
import { SipAuthEventService } from "../security/sip-auth-event.service";
import { PBX_DATABASE } from "../shared/pbx.tokens";
import { SipCredentialCache } from "./sip-credentials.cache";
import type { SipCredentialResponse } from "@optimiq-voice/events/schemas";
import type { PbxDatabaseClient, PbxDatabaseTransaction } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.pbx");

/**
 * The `rpc.sip.v1.credential` read model — what `apps/sipd` needs to authenticate a REGISTER.
 *
 * ## The chain this closes
 *
 * ```text
 * provision.service.ts   renders a phone's config with
 *                          password = hmac-sha256(rootKey, "<orgId>:<secretRef>") → base64url[0:24]
 * the phone              REGISTERs and answers a digest challenge computed from that password
 * apps/sipd              cannot check it: pbx-db is not its database
 * → this service         repeats the derivation and returns MD5(user:realm:password)
 * ```
 *
 * Before this existed, `provision-secret.ts` said so in as many words: "a provisioned phone
 * renders a correct-looking configuration whose password nothing yet checks". This is the other
 * half.
 *
 * ## Reproducing the renderer exactly, not approximately
 *
 * The password is a function of `secretRef`, so this service has to resolve the SAME `secretRef`
 * the renderer used for the same line, or the phone's config and its credential silently disagree.
 * `provision.service.ts` computes two values per device line:
 *
 * ```ts
 * const registerUser = row.extension?.number     ?? row.line.authUser     ?? undefined;
 * const secretRef    = row.extension?.sipSecretRef ?? row.line.sipSecretRef ?? undefined;
 * // and, separately:  authUser = row.line.authUser ?? registerUser
 * ```
 *
 * **The digest username on the wire is `authUser`, not `registerUser`** — a phone authenticates
 * with the auth id and registers the AOR. So the lookup here is keyed on the effective auth user,
 * `coalesce(device_line.auth_user, extension.number)`, and the secret is
 * `coalesce(extension.sip_secret_ref, device_line.sip_secret_ref)` — extension first, in that
 * order, exactly as above. Getting the precedence backwards would produce a valid-looking HA1 that
 * no phone can ever match.
 *
 * A softphone that was never given a device row is handled too: an extension whose `number` is the
 * username, deriving from `extension.sip_secret_ref`. That is the second query.
 *
 * ## Why a stored `sip_password_ha1` wins when it is present
 *
 * `extension.sip_password_ha1` is nullable and nothing writes it today. When a real secret manager
 * is wired, it will, and at that point the password is no longer derivable — so a stored digest
 * takes precedence and the derivation becomes the fallback. It carries one caveat the column
 * cannot express: a digest is computed against a REALM, and this service cannot tell which realm a
 * stored one was computed for. Whoever writes that column must re-write it on a realm change; the
 * derived path has no such problem, because the realm is an input here.
 *
 * ## Every read below runs at most once per account per minute
 *
 * The four queries this file issues are three PostgreSQL transactions and eleven round trips, and
 * a fleet re-registering on a 60 s expiry asked for all eleven every 30 s to be told the same
 * thing. {@link SipCredentialCache} sits in front of them: the realm directory and the resolved
 * answer are both memoized, and the API's own mutation seam evicts on the commit of every write
 * that could change one. Nothing about WHAT this file answers changed — the tenant resolution, the
 * `authUser` precedence and the shared-line appearance are all still resolved exactly as below, and
 * a refusal still reaches `sip_auth_event` on every attempt whether or not the answer came from
 * memory.
 */
@Injectable()
export class SipCredentialsService {
	constructor(
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		@Inject(SipAuthEventService) private readonly authEvents: SipAuthEventService,
		@Inject(SipCredentialCache) private readonly cache: SipCredentialCache,
	) {}

	async resolve(request: {
		realm: string;
		username: string;
		sourceAddress?: string;
	}): Promise<SipCredentialResponse> {
		const realm = request.realm.trim().toLowerCase();
		const username = request.username.trim();
		// The registering peer's address, carried by sipd. It decides nothing here — admission is
		// `sip_acl_entry`'s job at the edge — but it is the only field that lets a refusal be
		// correlated with a source, which is what an operator needs when a phone will not register or
		// when credentials are being sprayed. So it is logged on every refusal path and nowhere else.
		const sourceAddress = request.sourceAddress;

		const organizationId = await this.organizationForRealm(realm);
		if (organizationId === undefined) {
			// Not `found: false`. An unmapped realm is a DEPLOYMENT problem — nobody told this API
			// which tenant that realm belongs to — and reporting it as "no such account" would send
			// an operator hunting for an extension that exists.
			logger.warn(
				{ realm, username, sourceAddress },
				"refusing a credential lookup for an unmapped realm",
			);
			return refuse(
				`no organization is mapped to realm "${realm}" ` +
					`(set the org_setting sip/realm for the tenant that owns it)`,
			);
		}

		const cached = this.cache.lookup(organizationId, realm, username);
		if (cached !== undefined) {
			// A cached REFUSAL still files its security event and still logs. The cache exists to
			// remove three transactions from the read path, not to make a spray against one account
			// invisible to the attack log after the first attempt — `sip_auth_event` is the only place
			// the RATE of a refusal is visible at all, and a per-account rate that decays to zero
			// while the attempts continue is worse than no log.
			await this.reportRefusal(organizationId, cached, realm, username, sourceAddress);
			return cached;
		}

		const answer = await this.lookUp(organizationId, realm, username, sourceAddress);
		if (answer.cacheable) {
			this.cache.remember(organizationId, realm, username, answer.response);
		}
		return answer.response;
	}

	/**
	 * The uncached path: the three transactions the cache is there to skip.
	 *
	 * `cacheable` is false for every answer that is NOT a fact about a row — a missing
	 * `PROVISION_SIP_SECRET_KEY` is a deployment state that an operator fixes without touching any
	 * table, so remembering it would keep a whole fleet refused for a minute after the fix. "No such
	 * account" and "disabled" ARE facts about rows this API owns and evicts on write, so both are
	 * remembered.
	 */
	private async lookUp(
		organizationId: string,
		realm: string,
		username: string,
		sourceAddress: string | undefined,
	): Promise<{ readonly response: SipCredentialResponse; readonly cacheable: boolean }> {
		const rootKey = loadProvisioningEnv().PROVISION_SIP_SECRET_KEY;

		const line = await this.findLine(organizationId, username);
		if (line === undefined) {
			logger.warn(
				{ realm, username, organizationId, sourceAddress },
				"refusing a credential lookup: no line for that auth user",
			);
			await this.record(organizationId, "unknown-account", username, sourceAddress);
			return { response: { found: false, enabled: false }, cacheable: true };
		}
		if (!line.enabled) {
			logger.warn(
				{ realm, username, organizationId, sourceAddress },
				"refusing a credential lookup: the line is disabled",
			);
			await this.record(organizationId, "disabled-account", username, sourceAddress);
			return {
				response: { found: true, enabled: false, orgId: organizationId, username, realm },
				cacheable: true,
			};
		}

		const ha1 =
			line.storedHa1 ?? this.derive(rootKey, organizationId, line.secretRef, username, realm);
		if (ha1 === undefined) {
			// The renderer refuses to emit a config without the root key, so a deployment in this
			// state has no provisioned phones to authenticate anyway. Say which variable it is.
			logger.error(
				{
					realm,
					username,
					sourceAddress,
				},
				"cannot answer a credential lookup: PROVISION_SIP_SECRET_KEY is not set",
			);
			return {
				response: refuse("PROVISION_SIP_SECRET_KEY is not configured on this API"),
				cacheable: false,
			};
		}

		/**
		 * The appearance this account holds, when its extension is on a shared line.
		 *
		 * Resolved AFTER the credential — it changes nothing about whether the REGISTER authenticates,
		 * it only tells the device which shared-line key to light. sipd carries `sharedLineNumber` and
		 * `appearanceIndex` onto the binding and stamps `Call-Info: <sip:number@domain>;appearance-index=N`
		 * onto the INVITE and the dialog-info NOTIFY, so the phone lights the right button. An extension
		 * with no appearance simply leaves both fields absent, which is the ordinary reply this API has
		 * always sent.
		 */
		const appearance =
			line.extensionId === null
				? undefined
				: await this.findSharedLineAppearance(organizationId, line.extensionId);

		return {
			response: {
				found: true,
				enabled: true,
				orgId: organizationId,
				username,
				realm,
				ha1,
				deviceId: line.deviceId ?? undefined,
				extensionId: line.extensionId ?? undefined,
				maxRegistrations: line.maxRegistrations,
				...(appearance === undefined
					? {}
					: {
							...(appearance.sharedLineNumber === null
								? {}
								: { sharedLineNumber: appearance.sharedLineNumber }),
							appearanceIndex: appearance.appearanceIndex,
						}),
			},
			cacheable: true,
		};
	}

	/**
	 * The realm directory, through the cache.
	 *
	 * Separate from {@link SipCredentialsService.resolveOrganizationForRealm} rather than folded
	 * into it, because the query below is the one read in this file that runs OUTSIDE any tenant
	 * scope, and a cache in front of it is a cache in front of the tenant boundary itself. Keeping
	 * the memoization here leaves that method exactly what it was — the directory query, with its
	 * argument for the untenanted read intact — and makes the caching one readable layer above it.
	 */
	private async organizationForRealm(realm: string): Promise<string | undefined> {
		const cached = this.cache.lookupRealm(realm);
		if (cached !== undefined) {
			return cached.organizationId;
		}
		const organizationId = await this.resolveOrganizationForRealm(realm);
		this.cache.rememberRealm(realm, organizationId);
		return organizationId;
	}

	/**
	 * Re-files the security event and the operator log line for a refusal that came from the cache.
	 *
	 * Reads the refusal out of the RESPONSE rather than being told which kind it was, so the cached
	 * path and the uncached one cannot drift: `found: false` with no reason is "no such account"
	 * (the realm refusals carry a reason and never reach a per-account key), and a found-but-not-
	 * enabled account is a disabled one.
	 */
	private async reportRefusal(
		organizationId: string,
		response: SipCredentialResponse,
		realm: string,
		username: string,
		sourceAddress: string | undefined,
	): Promise<void> {
		if (!response.found && response.reason === undefined) {
			logger.warn(
				{ realm, username, organizationId, sourceAddress },
				"refusing a credential lookup: no line for that auth user",
			);
			await this.record(organizationId, "unknown-account", username, sourceAddress);
			return;
		}
		if (response.found && !response.enabled) {
			logger.warn(
				{ realm, username, organizationId, sourceAddress },
				"refusing a credential lookup: the line is disabled",
			);
			await this.record(organizationId, "disabled-account", username, sourceAddress);
		}
	}

	/**
	 * Files a refusal in the attack log.
	 *
	 * The realm already resolved, so the tenant is known and the event is attributable — which is the
	 * condition `security-schema.ts` sets for a row here. `sourceAddress` is `host:port` from the SIP
	 * edge and the column is an `inet`, so the port is dropped; an address the split does not produce
	 * is stored as NULL by the writer rather than refused.
	 *
	 * Never called for a WRONG PASSWORD: this service answers with an ha1 and never sees the digest,
	 * so `bad-credentials` can only be recorded by whoever verifies it. See the note in the class doc.
	 */
	private async record(
		organizationId: string,
		eventType: "unknown-account" | "disabled-account",
		username: string,
		sourceAddress: string | undefined,
	): Promise<void> {
		await this.authEvents.record({
			organizationId,
			eventType,
			scope: "registration",
			sourceIp: sourceAddress === undefined ? undefined : stripPort(sourceAddress),
			accountRef: username,
		});
	}

	/**
	 * The shared-line appearance this extension holds, or `undefined` when it is on none.
	 *
	 * One appearance is reported even when the extension is on several: the LOWEST-ordinal enabled
	 * appearance on the LOWEST-ordinal enabled line, which is the static button model the response
	 * schema documents — per-call appearance-slot assignment across simultaneous calls is the
	 * BroadWorks dynamic behaviour and a named seam beyond it. Both the line and the appearance must be
	 * enabled: a disabled line lights no lamp, and a disabled appearance is a button switched off.
	 *
	 * Scoped by the tenant the credential already resolved, so RLS is the filter and `organization_id`
	 * never appears in a predicate here — the same posture as `findLine`.
	 */
	private async findSharedLineAppearance(
		organizationId: string,
		extensionId: string,
	): Promise<{ sharedLineNumber: string | null; appearanceIndex: number } | undefined> {
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const rows = await transaction
				.select({
					sharedLineNumber: sharedLine.extensionNumber,
					appearanceIndex: sharedLineAppearance.ordinal,
				})
				.from(sharedLineAppearance)
				.innerJoin(sharedLine, eq(sharedLine.id, sharedLineAppearance.sharedLineId))
				.where(
					and(
						eq(sharedLineAppearance.extensionId, extensionId),
						eq(sharedLineAppearance.enabled, true),
						eq(sharedLine.enabled, true),
					),
				)
				.orderBy(asc(sharedLineAppearance.ordinal), asc(sharedLine.id))
				.limit(1);
			return rows[0];
		});
	}

	private derive(
		rootKey: string | undefined,
		organizationId: string,
		secretRef: string,
		username: string,
		realm: string,
	): string | undefined {
		if (rootKey === undefined) {
			return undefined;
		}
		const password = deriveSipPassword({ rootKey, organizationId, secretRef });
		return createHash("md5").update(`${username}:${realm}:${password}`, "utf8").digest("hex");
	}

	/**
	 * The realm → organization directory.
	 *
	 * Read through `adminDb`, i.e. **outside** any tenant scope, and that is not a shortcut: this
	 * is the query that FINDS the scope. Every other read in this area runs inside
	 * `withTenantScope` because the tenant is already known; here the tenant is the answer, and a
	 * scoped query would have to be told the very thing it is being asked.
	 *
	 * The mapping lives in `org_setting` (`category = 'sip'`, `name = 'realm'`) rather than in a
	 * column of its own, because `org_setting` is the settings cascade this schema already has and
	 * a `sip_domain` table is a migration this wave has no business making. When multi-realm
	 * tenancy becomes first-class the directory moves there and only this method changes.
	 *
	 * Two organizations claiming one realm is a configuration error and is refused rather than
	 * resolved arbitrarily: picking one would authenticate a phone against the wrong tenant's
	 * credential, which is the worst possible way to answer.
	 */
	private async resolveOrganizationForRealm(realm: string): Promise<string | undefined> {
		const rows = await this.database.adminDb
			.select({ organizationId: orgSetting.organizationId })
			.from(orgSetting)
			.where(
				and(
					eq(orgSetting.category, "sip"),
					eq(orgSetting.name, "realm"),
					eq(orgSetting.enabled, true),
					sql`lower(btrim(${orgSetting.value} #>> '{}')) = ${realm}`,
				),
			)
			.limit(2);

		if (rows.length === 0) {
			return undefined;
		}
		if (rows.length > 1) {
			logger.error({ realm }, "more than one organization claims the same SIP realm; refusing");
			return undefined;
		}
		return rows[0].organizationId;
	}

	/**
	 * The line this username authenticates as, resolved inside the tenant's scope.
	 *
	 * Device lines are consulted first because they are the more specific configuration — a line
	 * may override `auth_user`, and when it does, the extension's own number is not what the phone
	 * sends. The bare-extension query is the softphone case.
	 */
	private async findLine(
		organizationId: string,
		username: string,
	): Promise<LineIdentity | undefined> {
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			return (
				(await this.findDeviceLine(transaction, username)) ??
				(await this.findExtension(transaction, username))
			);
		});
	}

	/**
	 * ## Hot desking joins here, and the join is `home_extension_id`
	 *
	 * The extension this resolves the CREDENTIAL against is
	 * `coalesce(home_extension_id, extension_id)` — the binding the handset was PROVISIONED with,
	 * not the one it is currently routing for. That indirection is the whole reason hot desking can
	 * move `extension_id` at all.
	 *
	 * Without it, a `*31` would change either the digest username (when `auth_user` is NULL, since
	 * the username is `coalesce(auth_user, extension.number)`) or the HA1 (which comes from
	 * `extension.sip_password_ha1`) — and the phone would fall off the register mid-shift and need
	 * re-provisioning to come back. A hot-desk feature that unplugs the phone it is run on is not a
	 * feature, so the credential deliberately follows the HOME extension and only ROUTING follows
	 * the live one.
	 *
	 * `extensionId` in the reply stays the LIVE binding, and that asymmetry is intended: it is what
	 * `kv.Binding.ExtensionID` carries, so once the handset's next REGISTER refreshes the binding,
	 * calls for the claimed extension reach this AOR. The window between the rebind and that refresh
	 * is bounded by `device_line.register_expires_seconds`, and it is shortened by the mutation
	 * seam's credential invalidation, which drops the edge's cached copy on the commit.
	 */
	private async findDeviceLine(
		transaction: PbxDatabaseTransaction,
		username: string,
	): Promise<LineIdentity | undefined> {
		const rows = await transaction
			.select({
				deviceId: deviceLine.deviceId,
				extensionId: deviceLine.extensionId,
				lineEnabled: deviceLine.enabled,
				lineSecretRef: deviceLine.sipSecretRef,
				extensionEnabled: extension.enabled,
				extensionSecretRef: extension.sipSecretRef,
				storedHa1: extension.sipPasswordHa1,
				maxRegistrations: extension.maxRegistrations,
			})
			.from(deviceLine)
			.leftJoin(
				extension,
				sql`${extension.id} = coalesce(${deviceLine.homeExtensionId}, ${deviceLine.extensionId})`,
			)
			// `coalesce(auth_user, extension.number)` is the renderer's `authUser` exactly — and
			// `extension` is now the HOME extension, which is what keeps the username invariant across
			// a hot-desk session.
			.where(sql`coalesce(${deviceLine.authUser}, ${extension.number}) = ${username}`)
			.limit(2);

		if (rows.length === 0) {
			return undefined;
		}
		if (rows.length > 1) {
			// Two lines answering to one auth id is a data problem the registrar must not paper
			// over: whichever it picked, half the fleet would authenticate and half would not.
			logger.error({ username }, "more than one device line uses the same auth user; refusing");
			return undefined;
		}

		const row = rows[0];
		const secretRef = row.extensionSecretRef ?? row.lineSecretRef;
		if (secretRef === null || secretRef === undefined) {
			// The renderer SKIPS such a line rather than emitting an empty password, so there is no
			// provisioned credential to match. Reporting "no such account" is the honest answer.
			return undefined;
		}

		return {
			// A disabled extension disables its line, and a disabled line disables itself.
			enabled: row.lineEnabled && (row.extensionEnabled ?? true),
			secretRef,
			storedHa1: row.storedHa1 ?? undefined,
			deviceId: row.deviceId,
			extensionId: row.extensionId,
			maxRegistrations: row.maxRegistrations ?? undefined,
		};
	}

	private async findExtension(
		transaction: PbxDatabaseTransaction,
		username: string,
	): Promise<LineIdentity | undefined> {
		const rows = await transaction
			.select({
				id: extension.id,
				enabled: extension.enabled,
				secretRef: extension.sipSecretRef,
				storedHa1: extension.sipPasswordHa1,
				maxRegistrations: extension.maxRegistrations,
			})
			.from(extension)
			.where(eq(extension.number, username))
			.limit(1);

		const row = rows[0];
		if (row === undefined) {
			return undefined;
		}
		return {
			enabled: row.enabled,
			secretRef: row.secretRef,
			storedHa1: row.storedHa1 ?? undefined,
			deviceId: null,
			extensionId: row.id,
			maxRegistrations: row.maxRegistrations,
		};
	}
}

interface LineIdentity {
	readonly maxRegistrations: number | undefined;
	readonly enabled: boolean;
	readonly secretRef: string;
	readonly storedHa1: string | undefined;
	readonly deviceId: string | null;
	readonly extensionId: string | null;
}

/**
 * A refusal is `found: false` WITH a reason.
 *
 * The registrar answers 403 for `found: false` either way, so a caller learns nothing new; the
 * reason is for the operator reading the API's logs, which is the only place a "the realm is not
 * mapped" problem is diagnosable at all.
 */
/** `host:port` -> `host`. IPv6 arrives bracketed from the edge, so the brackets come off too. */
function stripPort(sourceAddress: string): string {
	const value = sourceAddress.trim();
	if (value.startsWith("[")) {
		const end = value.indexOf("]");
		return end === -1 ? value : value.slice(1, end);
	}
	const colon = value.lastIndexOf(":");
	return colon === -1 ? value : value.slice(0, colon);
}

function refuse(reason: string): SipCredentialResponse {
	return { found: false, enabled: false, reason: reason.slice(0, 256) };
}
