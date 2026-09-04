import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import { and, asc, eq, extension, extensionUser, orgSetting, sql } from "@optimiq-voice/pbx-db";
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
 * ## The honesty boundary is on the wire
 *
 * `media.webrtcSupported` is `false` and says why: `apps/sipd`'s WSS listener is SIGNALLING ONLY
 * (`apps/mediad` has no DTLS-SRTP yet), so the softphone REGISTERs, rings and tears down but carries
 * no audio. The UI reads this field rather than pretending otherwise.
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
			// derivable password. A 503 the UI renders as "not available on this deployment yet",
			// naming the variable an operator has to set — never a silent empty password.
			throw new ServiceUnavailableException({
				statusCode: 503,
				code: "SOFTPHONE_NOT_CONFIGURED",
				message: "PROVISION_SIP_SECRET_KEY is not configured on this API.",
			});
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
			return { extension: chosen, realm };
		});

		if (resolved === undefined) {
			// The gate the whole feature sits behind. A 404 the web reads as "you do not hold an
			// extension" — a stable fact about the caller, so the client does not retry it.
			throw new NotFoundException({
				statusCode: 404,
				code: "SOFTPHONE_NO_EXTENSION",
				message: "You do not hold an extension on this organization.",
			});
		}

		const realm = resolved.realm ?? this.env.PROVISION_SIP_SERVER;
		if (realm === undefined) {
			throw new ServiceUnavailableException({
				statusCode: 503,
				code: "SOFTPHONE_NO_REALM",
				message:
					"No SIP realm is configured for this organization (set the org_setting sip/realm, or " +
					"PROVISION_SIP_SERVER as the deployment default).",
			});
		}

		const row = resolved.extension;
		const password = deriveSipPassword({ rootKey, organizationId, secretRef: row.sipSecretRef });
		const displayName = row.callerIdName ?? row.label ?? row.number;

		return {
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
			media: { webrtcSupported: false, note: MEDIA_NOTE },
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

const MEDIA_NOTE =
	"The media plane's WebRTC leg (DTLS-SRTP in mediad) is the remaining piece; calls signal but " +
	"carry no audio yet.";

/** The wire shape of `GET /api/v1/me/softphone`. Mirrored in `apps/web/lib/softphone/contracts.ts`. */
export interface SoftphoneCredentialsResponse {
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
	readonly media: { readonly webrtcSupported: boolean; readonly note: string };
}
