import { createHmac } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import {
	and,
	asc,
	device,
	deviceLine,
	emergencyAddress,
	eq,
	extension,
	extensionUser,
	orgSetting,
	sql,
} from "@optimiq-voice/pbx-db";
import { formatDispatchableLocation } from "../../mail";
import { PBX_DATABASE } from "../../pbx/shared/pbx.tokens";
import { PROVISIONING_ENV } from "../provisioning.tokens";
import { deriveSipPassword } from "../render/provision-secret";
import type { ProvisioningEnv } from "../provisioning-env";
import type { AppSession } from "@optimiq-voice/auth";
import type { PbxDatabaseClient, PbxDatabaseTransaction } from "@optimiq-voice/pbx-db";

/**
 * `GET /api/v1/me/softphone` — the caller's OWN softphone credentials, for a browser SIP stack.
 *
 * ## The seam this closes, honestly
 *
 * `apps/web/lib/softphone/contracts.ts` documents this endpoint in full and the softphone shell
 * already fetches it; the server half was the missing wire. It is self-service — a user holding an
 * extension gets THEIR account without `devices.write` — so the route is authenticated-only and the
 * row it reads is bound to `session.user.id` through `extension_user`, never to an id from the
 * client.
 *
 * It composes three pieces that already exist and adds the two facts none of them expose:
 *   - the account fields mirror `SoftphoneAccountPayload` (`catalog/templates/softphone.ts`);
 *   - the SIP password is DERIVED exactly as `provision.service.ts` derives a desk phone's
 *     (`deriveSipPassword`), so the same registrar (`sip-credentials.service.ts`) authenticates it —
 *     a plaintext password, not the HA1 digest, because a browser SIP stack must answer
 *     arbitrary-realm challenges and cannot do so from a digest;
 *   - the REALM the browser registers into is the organization's own SIP realm, so sipd maps the
 *     REGISTER back to this tenant (the reverse of `sip-credentials.service.ts`'s realm→org lookup);
 *   - the sipd **WSS URL** — the one fact no committed contract carried — from `PROVISION_SIP_WSS_URL`.
 *
 * Browser audio is advertised only when the deployment enables WebRTC and configures WSS.
 * TURN credentials are short lived, scoped to this authenticated organization/user, and refreshed
 * by the browser before each call. The TURN shared secret never leaves the API.
 *
 * ## The three "no softphone" answers are 200s, not 4xx/5xx
 *
 * This route used to refuse three states by status: 404 `SOFTPHONE_NO_EXTENSION`, 503
 * `SOFTPHONE_NO_REALM`, 503 `SOFTPHONE_NOT_CONFIGURED`. The docked softphone provider is mounted in
 * the authenticated shell, so it asks this question on EVERY page — and an administrator who holds
 * no extension is the ordinary case, not an error. The 404 therefore put a red
 * `Failed to load resource` line in the browser console on every one of the 35 admin screens (41 in
 * one audit pass), which is how a real console error gets buried.
 *
 * None of the three is a failure of the request. "You hold no extension" is a fact about the
 * caller; "this organization has set no SIP domain" and "this deployment has no
 * `PROVISION_SIP_SECRET_KEY`" are facts about the configuration. All three are the honest ANSWER to
 * "what is my softphone?", so all three are 200 with `{ configured: false, reason }` —
 * {@link SoftphoneUnavailableResponse} — and only a genuine failure (no session, database down)
 * remains a non-200.
 *
 * `reason` is the field to branch on. Each body also carries the `code` that state used to be
 * refused with, so a client written against the old contract maps unchanged; that field is
 * deprecated and exists only to make the two deploys independent.
 */
@Injectable()
export class SoftphoneCredentialsService {
	constructor(
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		@Inject(PROVISIONING_ENV) private readonly env: ProvisioningEnv,
	) {}

	async forSelf(session: AppSession): Promise<SoftphoneCredentialsResponse> {
		const organizationId = requireActiveOrganizationId(session);

		const rootKey = this.env.PROVISION_SIP_SECRET_KEY;
		if (rootKey === undefined) {
			// The same state that stops a desk phone provisioning stops a softphone: no key, no
			// derivable password. Named, never a silent empty password.
			return unavailable(
				"not-provisioned",
				"PROVISION_SIP_SECRET_KEY is not configured on this API.",
			);
		}

		const resolved = await this.database.withTenantScope(organizationId, async (transaction) => {
			const rows = await transaction
				.select({
					id: extension.id,
					number: extension.number,
					label: extension.label,
					callerIdName: extension.callerIdName,
					sipSecretRef: extension.sipSecretRef,
					voicemailEnabled: extension.voicemailEnabled,
				})
				.from(extensionUser)
				.innerJoin(extension, eq(extension.id, extensionUser.extensionId))
				.where(and(eq(extensionUser.userId, session.user.id), eq(extension.enabled, true)))
				// The PRIMARY link first — a user with a primary and a delegate seat softphones as
				// themselves — then oldest, so the choice is stable across requests.
				.orderBy(asc(sql`(${extensionUser.role} <> 'primary')`), asc(extension.id))
				.limit(1);
			const chosen = rows[0];
			if (chosen === undefined) {
				return undefined;
			}
			const realm = await this.resolveRealm(transaction);
			const dispatchableLocation = await this.resolveDispatchableLocation(transaction, chosen.id);
			return { extension: chosen, realm, dispatchableLocation };
		});

		if (resolved === undefined) {
			// The gate the whole feature sits behind, and the commonest answer this endpoint gives:
			// every administrator who holds no extension asks it on every page. See the class header
			// for why that is a 200 and not a 404.
			return unavailable("no-extension", "You do not hold an extension on this organization.");
		}

		/**
		 * The realm is the ORGANIZATION's and has no deployment default.
		 *
		 * `PROVISION_SIP_SERVER` used to stand in here, and it cannot: `sip-credentials.service.ts`
		 * maps a realm to exactly one organization, so a tenant that configured none was handed a
		 * realm belonging to a DIFFERENT tenant — a credential that can never register, and, when the
		 * two tenants share an extension number, one that authenticates against the wrong tenant's
		 * account. Refusing by name is the only honest answer.
		 */
		const realm = resolved.realm;
		if (realm === undefined) {
			return unavailable(
				"no-realm",
				"SIP domain not configured for this organization. Set the calling domain in " +
					"Settings before using a softphone.",
			);
		}

		const row = resolved.extension;
		const password = deriveSipPassword({ rootKey, organizationId, secretRef: row.sipSecretRef });
		const displayName = row.callerIdName ?? row.label ?? row.number;
		const enabled =
			this.env.PROVISION_WEBRTC_ENABLED === true && this.env.PROVISION_SIP_WSS_URL !== undefined;
		const iceServers: SoftphoneIceServer[] = [];
		if (
			enabled &&
			this.env.PROVISION_TURN_SECRET !== undefined &&
			this.env.PROVISION_TURN_URLS !== undefined
		) {
			const username = `${Math.floor(Date.now() / 1000) + (this.env.PROVISION_TURN_TTL_SECONDS ?? 3600)}:${organizationId}:${session.user.id}`;
			iceServers.push({
				urls: this.env.PROVISION_TURN_URLS,
				username,
				credential: createHmac("sha1", this.env.PROVISION_TURN_SECRET)
					.update(username)
					.digest("base64"),
			});
		}

		return {
			configured: true,
			extension: { id: row.id, number: row.number, label: row.label, displayName },
			account: {
				username: row.number,
				authUsername: row.number,
				password,
				realm,
				registerExpiresSeconds: REGISTER_EXPIRES_SECONDS,
				voicemailNumber: row.voicemailEnabled ? row.number : null,
			},
			transport: { wssUrl: this.env.PROVISION_SIP_WSS_URL ?? null },
			dispatchableLocation: resolved.dispatchableLocation,
			media: {
				webrtcSupported: enabled,
				note: enabled
					? "Browser audio uses encrypted WebRTC media."
					: "Browser audio is not enabled on this deployment.",
				iceServers,
			},
		};
	}

	/**
	 * Where a 911 call from this browser will be dispatched to, from the caller's own handset.
	 *
	 * ## Why a softphone borrows a desk phone's location
	 *
	 * A browser client has no `device` row of its own, so it has no column to carry a dispatchable
	 * location — and it is also the endpoint that moves, which is precisely what RAY BAUM'S §9.8 is
	 * about. The honest thing this endpoint CAN do is show the user the address their extension will
	 * currently produce: the location registered against a handset on the same extension. That is the
	 * address a dispatcher would be read, so showing it is what lets somebody notice it is the wrong
	 * floor before they need it rather than after.
	 *
	 * It is deliberately not a claim about where the browser IS. The response carries the address and
	 * `validated`; the UI is what says "this is what your extension reports".
	 *
	 * `null` when the extension has no located handset — the ordinary case for an
	 * administrator — and a device carrying only a detail and no address contributes nothing, for the
	 * reason `provision.service.ts` gives: a refinement is not a location.
	 */
	private async resolveDispatchableLocation(
		transaction: PbxDatabaseTransaction,
		extensionId: string,
	): Promise<SoftphoneDispatchableLocation | null> {
		const rows = await transaction
			.select({ address: emergencyAddress, detail: device.emergencyLocationDetail })
			.from(deviceLine)
			.innerJoin(device, eq(device.id, deviceLine.deviceId))
			.innerJoin(emergencyAddress, eq(emergencyAddress.id, device.emergencyAddressId))
			.where(and(eq(deviceLine.extensionId, extensionId), eq(deviceLine.enabled, true)))
			// Stable across requests, so the address a user checked yesterday is the one they see today.
			.orderBy(asc(device.macAddress))
			.limit(1);
		const found = rows[0];
		if (found === undefined) {
			return null;
		}
		const formatted = formatDispatchableLocation(found.address, found.detail);
		return formatted.length === 0
			? null
			: {
					addressId: found.address.id,
					formatted,
					detail: found.detail,
					validated: found.address.validated,
				};
	}

	/** The organization's SIP realm from the settings cascade, or `undefined` when unset. */
	private async resolveRealm(transaction: PbxDatabaseTransaction): Promise<string | undefined> {
		const rows = await transaction
			.select({ value: sql<string>`${orgSetting.value} #>> '{}'` })
			.from(orgSetting)
			.where(
				and(
					eq(orgSetting.category, "sip"),
					eq(orgSetting.name, "realm"),
					eq(orgSetting.enabled, true),
				),
			)
			.limit(1);
		const value = rows[0]?.value?.trim();
		return value === undefined || value.length === 0 ? undefined : value;
	}
}

/**
 * How long a browser registration lasts before it must refresh.
 *
 * A softphone has no `device_line` row to read a per-line expiry from, so this is the default the
 * bare-extension path uses. 600s matches the floor `apps/web`'s `shapeSoftphoneCredentials` clamps
 * to, so the two never disagree about how often the UA re-registers.
 */
const REGISTER_EXPIRES_SECONDS = 600;

/** The dispatchable location shape `GET /api/v1/me/softphone` reports. */
export interface SoftphoneDispatchableLocation {
	readonly addressId: string;
	/** Every part on one line, address detail then desk detail. Never empty. */
	readonly formatted: string;
	/** The handset's own refinement — "Floor 3, desk by the window". */
	readonly detail: string | null;
	/** Whether the upstream provider validated the address. `false` is shown, never suppressed. */
	readonly validated: boolean;
}

export interface SoftphoneIceServer {
	readonly urls: readonly string[];
	readonly username: string;
	readonly credential: string;
}

/**
 * Why this caller has no softphone, as a value rather than a status code.
 *
 * Machine-readable and stable; the sentence beside it is not. A client branches on this and never
 * on the prose, exactly as `apps/web`'s `softphoneUnavailability` already branches on `code`.
 */
export const SOFTPHONE_UNAVAILABLE_REASONS = [
	"no-extension",
	"no-realm",
	"not-provisioned",
] as const;
export type SoftphoneUnavailableReason = (typeof SOFTPHONE_UNAVAILABLE_REASONS)[number];

/**
 * The legacy error `code` each reason used to be refused with.
 *
 * Carried in the 200 body so a client that already switches on `code` — `apps/web`'s
 * `softphoneUnavailability` does — keeps working across the status change without a coordinated
 * deploy. It is a compatibility field, not a second vocabulary: `reason` is the one to read.
 */
const LEGACY_CODES: Readonly<Record<SoftphoneUnavailableReason, string>> = {
	"no-extension": "SOFTPHONE_NO_EXTENSION",
	"no-realm": "SOFTPHONE_NO_REALM",
	"not-provisioned": "SOFTPHONE_NOT_CONFIGURED",
};

export interface SoftphoneUnavailableResponse {
	readonly configured: false;
	readonly reason: SoftphoneUnavailableReason;
	/** @deprecated Read `reason`. Present so a client written against the old refusals still maps. */
	readonly code: string;
	readonly message: string;
}

function unavailable(
	reason: SoftphoneUnavailableReason,
	message: string,
): SoftphoneUnavailableResponse {
	return { configured: false, reason, code: LEGACY_CODES[reason], message };
}

/** The wire shape of `GET /api/v1/me/softphone`. Mirrored in `apps/web/lib/softphone/contracts.ts`. */
export interface SoftphoneConfiguredResponse {
	readonly configured: true;
	readonly extension: {
		readonly id: string;
		readonly number: string;
		readonly label: string;
		readonly displayName: string;
	};
	readonly account: {
		readonly username: string;
		readonly authUsername: string;
		readonly password: string;
		readonly realm: string;
		readonly registerExpiresSeconds: number;
		readonly voicemailNumber: string | null;
	};
	readonly transport: { readonly wssUrl: string | null };
	/**
	 * The address a 911 call from this extension currently reports, or `null` when none is set.
	 *
	 * See {@link SoftphoneCredentialsService.resolveDispatchableLocation} for why a browser client
	 * borrows its extension's handset location rather than claiming one of its own.
	 */
	readonly dispatchableLocation: SoftphoneDispatchableLocation | null;
	readonly media: {
		readonly webrtcSupported: boolean;
		readonly note: string;
		readonly iceServers: readonly SoftphoneIceServer[];
	};
}

/**
 * The union `forSelf` answers with, always over HTTP 200.
 *
 * `configured` is the discriminant; narrow on it before touching `account`/`transport`.
 */
export type SoftphoneCredentialsResponse =
	| SoftphoneConfiguredResponse
	| SoftphoneUnavailableResponse;
