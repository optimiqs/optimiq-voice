import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { runEffect } from "@optimiq-voice/effect-runtime";
import { getLogger } from "@optimiq-voice/logging";
import { DEFAULT_FEATURE_CODES } from "@optimiq-voice/routing";
import { setOrganizationCreatedHandler } from "../../auth/auth.platform";
import { PbxResourceService } from "../shared/pbx-resource.service";
import { PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import { FEATURE_CODE_RESOURCE } from "./feature-codes.resource";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";
import type { AppSession, OrganizationCreatedEvent } from "@optimiq-voice/auth";

const logger = getLogger("api.pbx");

/** What {@link FeatureCodesService.seedDefaults} did, per code. */
export interface FeatureCodeSeedResult {
	/** Codes written by this call, in catalogue order. */
	readonly created: readonly string[];
	/** Codes the organization already had, whatever they point at now. */
	readonly skipped: readonly string[];
}

@Injectable()
export class FeatureCodesService extends PbxResourceService implements OnModuleInit {
	constructor(@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime) {
		super(runtime, FEATURE_CODE_RESOURCE);
	}

	/**
	 * Seed every organization created from here on, without anyone having to call the endpoint.
	 *
	 * `POST /api/v1/feature-codes/defaults` has existed for as long as {@link seedDefaults} has and
	 * nothing invoked it, so in practice a tenant created through sign-up still got zero codes —
	 * the endpoint made the catalogue *available*, not *applied*. Registering here closes that: the
	 * one call better-auth makes after an organization row exists lands on the same service method
	 * the endpoint calls, so there is one seeding implementation and the endpoint remains the
	 * manual re-run for organizations that predate this.
	 *
	 * The handler is registered rather than injected because `PbxModule` imports `AuthModule` and
	 * not the other way round; see `setOrganizationCreatedHandler`.
	 */
	onModuleInit(): void {
		setOrganizationCreatedHandler(async (event) => {
			await this.seedNewOrganization(event);
		});
	}

	/**
	 * The default codes for an organization that was created moments ago.
	 *
	 * ## Why a synthesized session
	 *
	 * The write path is deliberately session-shaped — the tenant and the audit actor are both read
	 * off a session, once, in `PbxResourceService`, so no repository can be wrong about either.
	 * better-auth's hook runs before the creator's session has the new organization on it (the
	 * plugin sets `activeOrganizationId` a few lines later), so the session it would hand over is
	 * still pointed at the previous tenant. Attributing the seed to the real creator against the
	 * new organization is the accurate record, and building that object here is smaller and more
	 * honest than teaching the service a second, sessionless write path.
	 *
	 * ## Why a failure is only logged
	 *
	 * A new organization without its star codes is one idempotent `POST …/defaults` away from
	 * being right. A sign-up that fails after the organization row is committed is not. So this
	 * never throws; `createAuth` swallows anyway, and this is the side that makes the swallow
	 * visible.
	 */
	private async seedNewOrganization(event: OrganizationCreatedEvent): Promise<void> {
		try {
			const result = await this.seedDefaults(sessionForSeeding(event));
			logger.info(
				{
					organizationId: event.organizationId,
					created: result.created.length,
					skipped: result.skipped.length,
				},
				"seeded the default feature codes for a new organization",
			);
		} catch (error) {
			logger.error(
				{ err: error, organizationId: event.organizationId },
				"could not seed the default feature codes for a new organization; " +
					"POST /api/v1/feature-codes/defaults re-runs it",
			);
		}
	}

	/**
	 * Give this organization the platform's default star codes.
	 *
	 * ## Why this exists at all
	 *
	 * `DEFAULT_FEATURE_CODES` has been the documented catalogue since the compiler was written, and
	 * until now nothing in production imported it: a new organization got an EMPTY `feature_code`
	 * table, so `*97`, `*72`, `*78` and every other code a phone system is expected to answer
	 * reached the internal context's no-match branch. `E2E-routing2.md` recorded it as "a new org
	 * gets zero feature codes", and the fix is to write the catalogue somebody already curated.
	 *
	 * ## Idempotent by CODE, not by row
	 *
	 * A code the organization already holds is left exactly as it is — including one that has been
	 * repointed, relabelled or disabled. Re-seeding must never undo a tenant's decision, and "the
	 * default catalogue" is a starting point rather than a state to converge on. That also makes
	 * this safe to call again after the catalogue grows: the next release's additions land and
	 * nothing else moves.
	 *
	 * Each write goes through the ordinary repository path, so every seeded row carries the same
	 * audit actor, the same tenant guard and the same compile-on-write a hand-created code does. In
	 * particular a seeded code that would collide with an existing one fails the recompile and is
	 * refused, which is the behaviour a tenant who already renumbered their codes needs.
	 */
	async seedDefaults(session: AppSession): Promise<FeatureCodeSeedResult> {
		const organizationId = this.organizationId(session);
		const existing = await this.existingCodes(organizationId);
		const created: string[] = [];
		const skipped: string[] = [];
		for (const seed of DEFAULT_FEATURE_CODES) {
			if (existing.has(seed.code)) {
				skipped.push(seed.code);
				continue;
			}
			await this.create(session, {
				code: seed.code,
				action: seed.action,
				label: seed.label,
				...(seed.params === undefined ? {} : { params: seed.params }),
			});
			created.push(seed.code);
		}
		return { created, skipped };
	}

	/**
	 * The codes this organization already holds.
	 *
	 * Read in one pass rather than probed per seed: the catalogue is twenty entries and a `select`
	 * per entry would be twenty round trips to answer one question. `enabled` is deliberately not
	 * filtered — a disabled `*97` is still a code the tenant owns, and seeding over it would
	 * resurrect something they switched off.
	 */
	private async existingCodes(organizationId: string): Promise<ReadonlySet<string>> {
		const page = await runEffect(this.runtime, (repository) =>
			repository.list(organizationId, FEATURE_CODE_RESOURCE, {
				page: 1,
				limit: Math.max(DEFAULT_FEATURE_CODES.length * 4, 100),
				search: undefined,
			}),
		);
		return new Set(
			page.data
				.map((row) => row.code)
				.filter((code): code is string => typeof code === "string" && code.length > 0),
		);
	}
}

/**
 * The creator, acting inside the organization they just created.
 *
 * Exported so the shape can be pinned by a test rather than only by the code that consumes it.
 * `token` and `expiresAt` are filled because `AppSession` requires them, and neither is read on
 * the write path: nothing here authenticates anything — the caller already did, by creating the
 * organization — and the fields that ARE read (the tenant, and the actor's user id) are real.
 */
export function sessionForSeeding(event: OrganizationCreatedEvent): AppSession {
	return {
		session: {
			id: event.organizationId,
			userId: event.userId,
			token: "",
			expiresAt: new Date(0),
			activeOrganizationId: event.organizationId,
		},
		user: {
			id: event.userId,
			email: event.userEmail,
			name: "",
			emailVerified: true,
		},
	};
}
