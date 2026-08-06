import { isIP } from "node:net";
import { Inject, Injectable } from "@nestjs/common";
import {
	and,
	asc,
	device,
	deviceKey,
	deviceLine,
	deviceProfile,
	deviceProfileKey,
	eq,
	extension,
	orgSetting,
	sql,
	type PbxDatabaseClient,
} from "@optimiq-voice/pbx-db";
import { PBX_DATABASE } from "../../pbx/shared/pbx.tokens";
import type {
	DeviceKeyCategory,
	DeviceKeyType,
	DeviceVendor,
	ProvisioningSettings,
	SipTransport,
} from "@optimiq-voice/pbx-db";

/**
 * The render path's data access.
 *
 * ## Why this is not `PbxRepository`
 *
 * `PbxRepository` is a declarative CRUD engine over a session's organization. The render path has
 * neither half of that: it has no session, and its first query has to run *before* a tenant is
 * known. Bending the declarative shape around that would mean widening a descriptor so one caller
 * can bypass the tenant scope — which is the one thing that file's design exists to make
 * impossible. So the render path gets its own eight-method repository, and the widening never
 * happens.
 *
 * ## The one untenanted query, and its blast radius
 *
 * {@link findByTokenReference} runs on `adminDb`, which bypasses RLS. That is not a loophole, it is
 * the documented reason `device_provisioning_token_key` is a global unique index: a phone's request
 * arrives with no organization, and something has to resolve one. The query is deliberately as
 * narrow as it can be — one indexed equality, `limit 1`, five columns, and NOT the settings, the
 * lines or anything else a caller could be tempted to use before authentication has finished.
 *
 * **Every subsequent read runs inside `withTenantScope(organizationId)`**, using the organization
 * this query returned. So an attacker who somehow made the token lookup return the wrong row would
 * get a configuration built entirely from that row's own tenant — never a mix, and never another
 * tenant's extensions.
 */
@Injectable()
export class ProvisionRepository {
	constructor(@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient) {}

	/**
	 * Resolves a token reference to the minimum needed to decide whether to continue.
	 *
	 * Returns the row for a DISABLED device and for a device in a suspended organization too: the
	 * caller has to be able to publish a `device.rejected` event naming the tenant, and refusing to
	 * return the row would make every rejection anonymous. What the caller must not do — and does
	 * not — is tell the phone which of those it was. See `provision.errors.ts`.
	 */
	async findByTokenReference(reference: string): Promise<TokenLookup | undefined> {
		const rows = await this.database.adminDb
			.select({
				id: device.id,
				organizationId: device.organizationId,
				macAddress: device.macAddress,
				vendor: device.vendor,
				model: device.model,
				enabled: device.enabled,
				provisioningToken: device.provisioningToken,
				provisioningTokenHash: device.provisioningTokenHash,
				provisioningTokenExpiresAt: device.provisioningTokenExpiresAt,
			})
			.from(device)
			.where(eq(device.provisioningToken, reference))
			.limit(1);
		return rows[0] as TokenLookup | undefined;
	}

	/**
	 * Everything the templates need, in one tenant-scoped transaction.
	 *
	 * One transaction rather than five queries so the configuration describes one consistent moment:
	 * a fleet-wide profile edit landing between the "read the profile" and "read the keys" queries
	 * would otherwise produce a config that is half old and half new, which is the kind of thing that
	 * is diagnosed once a year and never reproduced.
	 */
	async loadSnapshot(
		organizationId: string,
		deviceId: string,
	): Promise<RenderSnapshot | undefined> {
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const deviceRows = await transaction
				.select()
				.from(device)
				.where(eq(device.id, deviceId))
				.limit(1);
			const deviceRow = deviceRows[0];
			if (deviceRow === undefined) {
				return undefined;
			}

			const profileRows =
				deviceRow.deviceProfileId === null
					? []
					: await transaction
							.select()
							.from(deviceProfile)
							.where(eq(deviceProfile.id, deviceRow.deviceProfileId))
							.limit(1);
			const profileRow = profileRows[0];

			/**
			 * The lines, left-joined to their extension.
			 *
			 * A LEFT join rather than an inner one: a line whose extension was deleted has
			 * `extension_id = NULL` (the FK is `ON DELETE SET NULL`), and an inner join would silently
			 * drop it from the rendered config. The renderer needs to SEE that line so it can leave the
			 * account disabled rather than shifting every subsequent account up by one — which would
			 * hand line 3's credentials to the key labelled line 2.
			 */
			const lineRows = await transaction
				.select({ line: deviceLine, extension })
				.from(deviceLine)
				.leftJoin(extension, eq(deviceLine.extensionId, extension.id))
				.where(eq(deviceLine.deviceId, deviceId))
				.orderBy(asc(deviceLine.lineNumber));

			const keyRows = await transaction
				.select()
				.from(deviceKey)
				.where(eq(deviceKey.deviceId, deviceId))
				.orderBy(asc(deviceKey.category), asc(deviceKey.keyIndex));

			const profileKeyRows =
				profileRow === undefined
					? []
					: await transaction
							.select()
							.from(deviceProfileKey)
							.where(eq(deviceProfileKey.deviceProfileId, profileRow.id))
							.orderBy(asc(deviceProfileKey.category), asc(deviceProfileKey.keyIndex));

			/**
			 * The organization level of the cascade.
			 *
			 * `category = 'provision'` and nothing else: the settings table is shared with every other
			 * area, and a renderer that read the whole table would put a tenant's e-mail template into a
			 * desk phone's config file. `enabled = false` is a row an administrator switched off, which
			 * means it does not participate.
			 */
			const settingRows = await transaction
				.select({ name: orgSetting.name, value: orgSetting.value })
				.from(orgSetting)
				.where(and(eq(orgSetting.category, "provision"), eq(orgSetting.enabled, true)));

			return {
				device: deviceRow,
				profile: profileRow,
				lines: lineRows,
				keys: keyRows,
				profileKeys: profileKeyRows,
				organizationSettings: toSettings(settingRows),
			} as RenderSnapshot;
		});
	}

	/**
	 * Whether this source address is allowed to fetch configurations for this organization.
	 *
	 * The matching is Postgres's, not ours: `inet <<= cidr` understands IPv4, IPv6 and the
	 * v4-mapped-v6 addresses a dual-stack listener reports, and a hand-rolled prefix comparison would
	 * get the third case wrong in the direction that refuses legitimate phones.
	 *
	 * Precedence is `deny` before `allow` at the same specificity, then longest prefix, then
	 * `priority` — the order `sip_acl_entry`'s own documentation states ("lower first, ties broken by
	 * the most specific prefix"), with deny winning an exact tie because an ACL whose deny can be
	 * overridden by an equally-specific allow is an ACL that cannot express an exception.
	 */
	async checkAllowlist(organizationId: string, sourceIp: string): Promise<AllowlistVerdict> {
		if (isIP(sourceIp) === 0) {
			// Not an address we can match. Treated as "no entries applied" rather than as a denial: the
			// caller decides what an unmatched request means, and refusing here would make a deployment
			// behind a proxy that reports a hostname unprovisionable with no diagnostic.
			return { hasEntries: false, allowed: false, matched: undefined };
		}

		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const result = await transaction.execute(sql`
				select
					count(*) filter (where scope = 'provisioning' and enabled) as entry_count,
					(
						select action
						from sip_acl_entry
						where scope = 'provisioning'
						  and enabled
						  and ${sourceIp}::inet <<= network
						order by
							masklen(network) desc,
							case when action = 'deny' then 0 else 1 end,
							priority asc
						limit 1
					) as decision,
					(
						select host(network) || '/' || masklen(network)
						from sip_acl_entry
						where scope = 'provisioning'
						  and enabled
						  and ${sourceIp}::inet <<= network
						order by
							masklen(network) desc,
							case when action = 'deny' then 0 else 1 end,
							priority asc
						limit 1
					) as matched
				from sip_acl_entry
			`);

			const row = readRow(result);
			const entryCount = Number(row?.entry_count ?? 0);
			const decision =
				row?.decision === undefined || row.decision === null ? undefined : String(row.decision);
			return {
				hasEntries: entryCount > 0,
				allowed: decision === "allow",
				matched:
					row?.matched === null || row?.matched === undefined ? undefined : String(row.matched),
			};
		});
	}

	/** Records a successful render. Best-effort: see `provision.service.ts` for why it cannot fail. */
	async recordProvisioned(
		organizationId: string,
		deviceId: string,
		sourceIp: string | undefined,
	): Promise<void> {
		await this.database.withTenantScope(organizationId, async (transaction) => {
			await transaction
				.update(device)
				.set({
					lastProvisionedAt: new Date(),
					lastProvisionedIp: sourceIp ?? null,
				})
				.where(eq(device.id, deviceId));
		});
	}
}

// ---------------------------------------------------------------------------------------------

export interface TokenLookup {
	readonly id: string;
	readonly organizationId: string;
	readonly macAddress: string;
	readonly vendor: DeviceVendor;
	readonly model: string | null;
	readonly enabled: boolean;
	readonly provisioningToken: string;
	readonly provisioningTokenHash: string | null;
	readonly provisioningTokenExpiresAt: Date | null;
}

export interface AllowlistVerdict {
	/** Whether the organization has any enabled provisioning ACL entries at all. */
	readonly hasEntries: boolean;
	/** Whether the winning entry was an `allow`. Meaningless when `hasEntries` is false. */
	readonly allowed: boolean;
	readonly matched: string | undefined;
}

export interface SnapshotLineRow {
	readonly line: typeof deviceLine.$inferSelect;
	readonly extension: typeof extension.$inferSelect | null;
}

export interface RenderSnapshot {
	readonly device: typeof device.$inferSelect;
	readonly profile: typeof deviceProfile.$inferSelect | undefined;
	readonly lines: readonly SnapshotLineRow[];
	readonly keys: readonly (typeof deviceKey.$inferSelect)[];
	readonly profileKeys: readonly (typeof deviceProfileKey.$inferSelect)[];
	readonly organizationSettings: ProvisioningSettings;
}

/** Re-exported so templates and the service can name key shapes without a schema import. */
export type { DeviceKeyCategory, DeviceKeyType, SipTransport };

/**
 * `org_setting.value` is JSONB, so it can hold a shape the cascade cannot use.
 *
 * A settings value is a scalar by definition — it is interpolated into a `key = value` line — so an
 * object or an array here is a row somebody wrote for a different consumer, and it is skipped
 * rather than stringified. `JSON.stringify`-ing it would put `{"a":1}` into a phone's config, which
 * parses as garbage and reports nothing.
 */
function toSettings(
	rows: readonly { readonly name: string; readonly value: unknown }[],
): ProvisioningSettings {
	const settings: Record<string, string | number | boolean> = {};
	for (const row of rows) {
		const value = row.value;
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			settings[row.name] = value;
		}
	}
	return settings;
}

function readRow(result: unknown): Record<string, unknown> | undefined {
	if (Array.isArray(result)) {
		return result[0] as Record<string, unknown> | undefined;
	}
	const rows = (result as { rows?: unknown }).rows;
	return Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
}
