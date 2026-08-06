import { Inject, Injectable } from "@nestjs/common";
import { PbxChildResourceService, PbxResourceService } from "../../pbx/shared/pbx-resource.service";
import { PBX_EFFECT_RUNTIME } from "../../pbx/shared/pbx.tokens";
import { PROVISIONING_ENV } from "../provisioning.tokens";
import { mintProvisioningToken, provisioningConfigUrl } from "../render/provision-token";
import { ProvisioningNotConfiguredException } from "../render/provision.errors";
import {
	DEVICE_KEY_RESOURCE,
	DEVICE_LINE_RESOURCE,
	DEVICE_PROFILE_KEY_RESOURCE,
	DEVICE_PROFILE_RESOURCE,
	DEVICE_RESOURCE,
} from "./devices.resource";
import type { MutationEnvelope } from "../../pbx/shared/pbx-resource.service";
import type { PbxRepositoryRuntime } from "../../pbx/shared/pbx-runtime";
import type { ProvisioningEnv } from "../provisioning-env";
import type { AppSession } from "@optimiq-voice/auth";

@Injectable()
export class DeviceProfilesService extends PbxResourceService {
	constructor(@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime) {
		super(runtime, DEVICE_PROFILE_RESOURCE);
	}
}

@Injectable()
export class DeviceProfileKeysService extends PbxChildResourceService {
	constructor(@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime) {
		super(runtime, DEVICE_PROFILE_KEY_RESOURCE);
	}
}

@Injectable()
export class DeviceLinesService extends PbxChildResourceService {
	constructor(@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime) {
		super(runtime, DEVICE_LINE_RESOURCE);
	}
}

@Injectable()
export class DeviceKeysService extends PbxChildResourceService {
	constructor(@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime) {
		super(runtime, DEVICE_KEY_RESOURCE);
	}
}

/** A device row plus the token that was just minted for it. The token appears here and nowhere else. */
export type ProvisionedDeviceEnvelope = MutationEnvelope<Record<string, unknown>> & {
	readonly provisioning: ProvisioningTokenResult;
};

/** What a freshly minted provisioning URL looks like on the wire. Shown once, never re-readable. */
export interface ProvisioningTokenResult {
	/** The complete `<reference>.<secret>` token. */
	readonly token: string;
	/** The URL a phone fetches. Absent when `PROVISION_BASE_URL` is not set. */
	readonly configUrl: string | null;
	readonly expiresAt: string | null;
}

@Injectable()
export class DevicesService extends PbxResourceService {
	constructor(
		@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime,
		@Inject(PROVISIONING_ENV) private readonly env: ProvisioningEnv,
	) {
		super(runtime, DEVICE_RESOURCE);
	}

	/**
	 * Mints a new provisioning token for a device and invalidates the old one.
	 *
	 * ## Why this goes through the ordinary update path
	 *
	 * `provisioningToken` and `provisioningTokenHash` are deliberately absent from
	 * `updateDeviceDto` — a form that could set them could set one an attacker already knows — but
	 * they are ordinary columns, and the repository's `update` is what already knows how to answer
	 * "no such device in this organization" with a 404 that leaks nothing, how to turn a unique
	 * violation into a 409, and how to keep the write inside a tenant-scoped transaction. Reaching
	 * past it to a hand-written `UPDATE` would be a second implementation of all three, and the one
	 * that would be missing the RLS scope the day somebody refactored it.
	 *
	 * The rotation is a single UPDATE, so there is no window in which both tokens work and none in
	 * which neither does: the old URL stops resolving at the instant the new one starts.
	 *
	 * ## Why the plaintext token is returned and not stored
	 *
	 * This is the only moment it exists. `device.provisioning_token` holds the non-secret reference
	 * and `device.provisioning_token_hash` holds the secret's digest, so an administrator who closes
	 * this dialog without copying the URL has to rotate again — which is the same trade the trunk
	 * provisioning panel makes for a SIP password, and for the same reason.
	 */
	async regenerateProvisioningToken(
		session: AppSession,
		id: string,
		options: { readonly expiresInDays?: number } = {},
	): Promise<ProvisionedDeviceEnvelope> {
		const minted = mintProvisioningToken();
		const expiresAt = this.expiryFor(options.expiresInDays);

		const result = await this.update(session, id, {
			provisioningToken: minted.reference,
			provisioningTokenHash: minted.secretHash,
			provisioningTokenExpiresAt: expiresAt,
			// A rotation resets the check-in record too. Leaving `lastProvisionedAt` in place would
			// have the UI report "provisioned 10 minutes ago" about a URL that no longer works.
			lastProvisionedAt: null,
			lastProvisionedIp: null,
		});

		return { ...result, provisioning: this.describe(minted, expiresAt) };
	}

	/**
	 * Creates a device and mints its first token in ONE write.
	 *
	 * `device.provisioning_token` is `NOT NULL` with no default, so a device without a token cannot
	 * exist — which means the token has to be part of the insert rather than a follow-up update.
	 * That is the right shape anyway: a two-step create would leave a window in which the row is
	 * invalid, and it would make a failure between the halves produce a device nobody can provision
	 * and nobody can tell apart from one that simply has not been set up.
	 *
	 * The columns are injected here rather than accepted from the DTO on purpose — see the note on
	 * `updateDeviceDto` for why a client must never be able to name its own token.
	 */
	async createWithProvisioningToken(
		session: AppSession,
		values: Record<string, unknown>,
		options: { readonly expiresInDays?: number } = {},
	): Promise<ProvisionedDeviceEnvelope> {
		const minted = mintProvisioningToken();
		const expiresAt = this.expiryFor(options.expiresInDays);

		const result = await this.create(session, {
			...values,
			provisioningToken: minted.reference,
			provisioningTokenHash: minted.secretHash,
			provisioningTokenExpiresAt: expiresAt,
		});

		return { ...result, provisioning: this.describe(minted, expiresAt) };
	}

	/** `null` means the token does not expire, which is the default and the common case. */
	private expiryFor(expiresInDays: number | undefined): Date | null {
		const ttlDays = expiresInDays ?? this.env.PROVISION_TOKEN_TTL_DAYS;
		return ttlDays === 0 ? null : new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
	}

	private describe(
		minted: { readonly token: string },
		expiresAt: Date | null,
	): ProvisioningTokenResult {
		return {
			token: minted.token,
			configUrl:
				this.env.PROVISION_BASE_URL === undefined
					? null
					: provisioningConfigUrl(this.env.PROVISION_BASE_URL, minted.token),
			expiresAt: expiresAt?.toISOString() ?? null,
		};
	}

	/**
	 * Refuses with a 503 when the deployment cannot render a configuration yet.
	 *
	 * Called by the controller before a token is minted, because handing somebody a URL that will
	 * answer 503 to every phone that fetches it is worse than telling them now which variable is
	 * missing. The CRUD surface itself stays available — see `provisioning-env.ts` for why the
	 * inventory is useful before the SIP edge exists.
	 */
	assertRenderConfigured(): void {
		ProvisioningNotConfiguredException.assert(this.env);
	}
}
