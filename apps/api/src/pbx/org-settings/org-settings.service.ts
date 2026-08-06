import { Inject, Injectable } from "@nestjs/common";
import { runEffect } from "@optimiq-voice/effect-runtime";
import { and, eq, orgSetting } from "@optimiq-voice/pbx-db";
import { PbxResourceService } from "../shared/pbx-resource.service";
import { PBX_DATABASE, PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import {
	findSetting,
	NOTIFICATION_SETTINGS_CATEGORY,
	resolveCategory,
	settingsInCategory,
} from "./org-settings.catalog";
import { parseCategoryPatch } from "./org-settings.dto";
import {
	InvalidSettingPatchException,
	UnknownSettingCategoryException,
} from "./org-settings.errors";
import { ORG_SETTING_RESOURCE } from "./org-settings.resource";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";
import type { CategoryPatch } from "./org-settings.dto";
import type { AppSession } from "@optimiq-voice/auth";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * The organization settings cascade's write path — the thing this table did not have.
 *
 * ## Two surfaces over one table, and why neither can be dropped
 *
 * The inherited `PbxResourceService` half is raw row CRUD: list, get, create, update, delete, by
 * id, over any `(category, name)`. It is what the uncatalogued categories need — `provision` rows
 * are read by `provision.repository.ts` as whatever a device template asks for — and it is what an
 * operator tool uses.
 *
 * {@link readCategory} / {@link patchCategory} are the surface a settings SCREEN uses: the whole
 * category resolved through the cascade (code default overlaid by rows), and a partial object
 * saved as a unit. A form cannot use the raw half, because it does not know which of its fields
 * already have rows, and finding out first would be N round trips and a race with a concurrent
 * save.
 *
 * ## Every write still goes through the repository
 *
 * `affectsRouting("org_setting")` is true. {@link patchCategory} therefore resolves each name to a
 * row id and calls the repository's `create`/`update` — never `withTenantScope` and an INSERT —
 * so compile-on-write runs and the routing artifact is recompiled and republished exactly as it is
 * for an extension. The reads go direct, which is the seam `VoicemailMessagesService` already
 * uses: a read needs no compile and the repository has no "select where category = ?" method.
 *
 * ## Why the upsert is not `on conflict do update`
 *
 * It would be one statement instead of two, and it would bypass the repository — which is the
 * whole point of routing writes through it. The lookup-then-write is inside one tenant scope for
 * the lookup and one repository call per setting; a concurrent writer that inserts the same
 * `(category, name)` between the two loses to the unique index and surfaces as the area's
 * conflict, which is the correct answer to two people saving the same settings form.
 */
@Injectable()
export class OrgSettingsService extends PbxResourceService {
	constructor(
		@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime,
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
	) {
		super(runtime, ORG_SETTING_RESOURCE);
	}

	/**
	 * One category, resolved: `{ voicemailToEmailEnabled: true, fromName: null, … }`.
	 *
	 * Every catalogued name is present in the answer, always — a key missing from a settings
	 * response is indistinguishable from a key whose value is `undefined`, and a form binding to
	 * the second would render an uncontrolled input.
	 */
	async readCategory(
		session: AppSession,
		category: string,
	): Promise<{
		readonly data: Record<string, unknown>;
		readonly category: string;
	}> {
		const organizationId = this.organizationId(session);
		this.requireCatalogued(category);
		return {
			category,
			data: resolveCategory(category, await this.readRows(organizationId, category)),
		};
	}

	/**
	 * Saves a partial category.
	 *
	 * The patch is validated in full BEFORE anything is written (guard-then-execute): a form that
	 * sent one bad field and four good ones must not half-save, because the user cannot tell which
	 * half landed and the screen will show them the result of a state nobody chose.
	 */
	async patchCategory(
		session: AppSession,
		category: string,
		patch: CategoryPatch,
	): Promise<{
		readonly data: Record<string, unknown>;
		readonly category: string;
		readonly written: readonly string[];
	}> {
		const organizationId = this.organizationId(session);
		this.requireCatalogued(category);

		const parsed = parseCategoryPatch(category, patch);
		if (parsed.outcome === "invalid") {
			throw new InvalidSettingPatchException(category, parsed.issues);
		}

		const existing = new Map(
			(await this.readRows(organizationId, category)).map((row) => [row.name, row]),
		);
		const written: string[] = [];

		for (const [name, value] of parsed.values) {
			const descriptor = findSetting(category, name);
			if (descriptor === undefined) {
				// Unreachable: `parseCategoryPatch` only returns catalogued names. Narrowing rather
				// than asserting, because a `!` here would be the one place this file could throw a
				// TypeError instead of an HTTP error.
				continue;
			}
			const row = existing.get(name);
			if (row === undefined) {
				await runEffect(this.runtime, (repository) =>
					repository.create(organizationId, this.resource, {
						category,
						name,
						value,
						valueType: descriptor.valueType,
						description: descriptor.label,
						enabled: true,
					}),
				);
			} else {
				await runEffect(this.runtime, (repository) =>
					repository.update(organizationId, this.resource, row.id, {
						value,
						valueType: descriptor.valueType,
						// A save re-enables a row somebody had switched off: the cascade reads a disabled
						// row as absent, so leaving it disabled would silently discard the value the user
						// just typed.
						enabled: true,
					}),
				);
			}
			written.push(name);
		}

		return {
			category,
			written,
			data: resolveCategory(category, await this.readRows(organizationId, category)),
		};
	}

	/**
	 * The notification settings for one organization, without a session.
	 *
	 * The voicemail-to-email consumer's entry point: it acts on a NATS delivery, so there is no
	 * session to read a tenant from and the organization id comes from the event's subject instead.
	 * Everything below it is unchanged — the read still runs inside `withTenantScope`, so RLS is
	 * still the filter.
	 */
	async readNotificationSettingsFor(organizationId: string): Promise<NotificationSettings> {
		const resolved = resolveCategory(
			NOTIFICATION_SETTINGS_CATEGORY,
			await this.readRows(organizationId, NOTIFICATION_SETTINGS_CATEGORY),
		);
		return {
			voicemailToEmailEnabled: resolved.voicemailToEmailEnabled === true,
			voicemailToEmailIncludeLink: resolved.voicemailToEmailIncludeLink === true,
			voicemailToEmailIncludeTranscription: resolved.voicemailToEmailIncludeTranscription === true,
			fromName: typeof resolved.fromName === "string" ? resolved.fromName : undefined,
			replyTo: typeof resolved.replyTo === "string" ? resolved.replyTo : undefined,
		};
	}

	// -------------------------------------------------------------------------------------------
	// Internals
	// -------------------------------------------------------------------------------------------

	private requireCatalogued(category: string): void {
		if (settingsInCategory(category).length === 0) {
			throw new UnknownSettingCategoryException(category);
		}
	}

	private async readRows(organizationId: string, category: string): Promise<readonly SettingRow[]> {
		return await this.database.withTenantScope(organizationId, async (transaction) =>
			transaction
				.select({
					id: orgSetting.id,
					name: orgSetting.name,
					value: orgSetting.value,
					enabled: orgSetting.enabled,
				})
				.from(orgSetting)
				// `enabled` is NOT a predicate here: a disabled row still has to be found so a save can
				// re-enable it rather than colliding with the unique index. The cascade's "disabled
				// means absent" rule is applied by `resolveCategory`, one layer up, where it belongs.
				.where(and(eq(orgSetting.category, category))),
		);
	}
}

interface SettingRow {
	readonly id: string;
	readonly name: string;
	readonly value: unknown;
	readonly enabled: boolean;
}

/** The notification settings, typed for the consumers that act on them. */
export interface NotificationSettings {
	readonly voicemailToEmailEnabled: boolean;
	readonly voicemailToEmailIncludeLink: boolean;
	readonly voicemailToEmailIncludeTranscription: boolean;
	readonly fromName: string | undefined;
	readonly replyTo: string | undefined;
}
