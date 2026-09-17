import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { eq, trunk, type PbxDatabaseClient } from "@optimiq-voice/pbx-db";
import { TELNYX_CLIENT } from "../carrier/carrier.tokens";
import { PBX_DATABASE } from "../shared/pbx.tokens";
import type {
	SipTrunkCredentialRequest,
	SipTrunkCredentialResponse,
} from "@optimiq-voice/events/schemas";
import type { TelnyxClient } from "@optimiq-voice/telnyx";

const HASH_ALGORITHMS = {
	MD5: "md5",
	"SHA-256": "sha256",
	"SHA-512-256": "sha512-256",
} as const;

/** Resolves carrier digests on the control plane; carrier passwords never enter NATS or KV. */
@Injectable()
export class TrunkCredentialsService {
	private readonly cache = new Map<string, { ha1: string; expiresAt: number }>();

	constructor(
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		@Inject(TELNYX_CLIENT) private readonly telnyx: TelnyxClient | undefined,
	) {}

	async resolve(request: SipTrunkCredentialRequest): Promise<SipTrunkCredentialResponse> {
		const rows = await this.database.withTenantScope(
			request.orgId,
			async (transaction) =>
				await transaction
					.select({
						enabled: trunk.enabled,
						kind: trunk.kind,
						authUser: trunk.authUser,
						secretRef: trunk.sipSecretRef,
						provider: trunk.carrierProvider,
						carrierRef: trunk.carrierRef,
						updatedAt: trunk.updatedAt,
					})
					.from(trunk)
					.where(eq(trunk.id, request.trunkId))
					.limit(1),
		);
		const row = rows[0];
		if (
			!row?.enabled ||
			row.kind !== "register" ||
			row.authUser !== request.username ||
			row.secretRef !== request.secretRef
		) {
			return { ok: false, reason: "trunk credential is unavailable" };
		}
		if (row.provider !== "telnyx" || !row.carrierRef || !this.telnyx) {
			return { ok: false, reason: "carrier credential provider is unavailable" };
		}

		const key = JSON.stringify([
			request.orgId,
			request.trunkId,
			row.carrierRef,
			row.updatedAt.getTime(),
			request.secretRef,
			request.username,
			request.realm,
			request.algorithm,
		]);
		let cached = this.cache.get(key);
		if (!cached || cached.expiresAt <= Date.now()) {
			const connection = await this.telnyx.credentialConnections.get(row.carrierRef);
			if (
				connection.active === false ||
				connection.user_name !== request.username ||
				!connection.password
			) {
				return { ok: false, reason: "carrier credential is unavailable" };
			}
			cached = {
				ha1: createHash(HASH_ALGORITHMS[request.algorithm])
					.update(request.username + ":" + request.realm + ":" + connection.password, "utf8")
					.digest("hex"),
				expiresAt: Date.now() + 30_000,
			};
			if (this.cache.size >= 1_000) {
				const oldest = this.cache.keys().next().value;
				if (oldest !== undefined) this.cache.delete(oldest);
			}
			this.cache.set(key, cached);
		}
		return {
			ok: true,
			orgId: request.orgId,
			trunkId: request.trunkId,
			username: request.username,
			realm: request.realm,
			algorithm: request.algorithm,
			ha1: cached.ha1,
		};
	}
}
