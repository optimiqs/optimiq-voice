import { Inject, Injectable } from "@nestjs/common";
import { hasPermission } from "@optimiq-voice/auth";
import { runEffect } from "@optimiq-voice/effect-runtime";
import { and, eq, orgSetting, userSetting } from "@optimiq-voice/pbx-db";
import { PbxResourceService } from "../shared/pbx-resource.service";
import { PBX_DATABASE, PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import {
	CATEGORY_PERMISSIONS,
	findSetting,
	NOTIFICATION_SETTINGS_CATEGORY,
	RECORDING_RETENTION_SETTING,
	RECORDING_SETTINGS_CATEGORY,
	resolveCategory,
	resolveForUser,
	settingsInCategory,
	USER_SCOPED_CATEGORIES,
	userScopedSettingsInCategory,
} from "./org-settings.catalog";
import { parseCategoryPatch } from "./org-settings.dto";
import {
	InvalidSettingPatchException,
	SettingCategoryForbiddenException,
	UnknownSettingCategoryException,
} from "./org-settings.errors";
import { ORG_SETTING_RESOURCE, USER_SETTING_RESOURCE } from "./org-settings.resource";
import type { MutationEnvelope } from "../shared/pbx-resource.service";
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
 * {@link readOwnSettings} / {@link patchOwnCategory} are the third surface, over the OTHER table:
 * `user_setting`, the cascade level `settings-schema.ts` brought back. Same shape as the category
 * facade, restricted to the settings the catalogue marks user-scoped, and pinned to the caller —
 * the service writes `userId: session.user.id` and can never be asked for another user's id.
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
		this.requireCategoryPermission(session, category, "read");
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
		this.requireCategoryPermission(session, category, "write");

		const parsed = parseCategoryPatch(category, patch);
		if (parsed.outcome === "invalid") {
			throw new InvalidSettingPatchException(category, parsed.issues);
		}

		const existing = new Map(
			(await this.readRows(organizationId, category)).map((row) => [row.name, row]),
		);
		const written: string[] = [];
		// One actor for the whole patch: a settings form is one action by one person, and deriving it
		// per setting would put N identical objects in the ledger's call path for no gain.
		const actor = this.actor(session);

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
					repository.create(
						organizationId,
						this.resource,
						{
							category,
							name,
							value,
							valueType: descriptor.valueType,
							description: descriptor.label,
							enabled: true,
						},
						actor,
					),
				);
			} else {
				await runEffect(this.runtime, (repository) =>
					repository.update(
						organizationId,
						this.resource,
						row.id,
						{
							value,
							valueType: descriptor.valueType,
							// A save re-enables a row somebody had switched off: the cascade reads a disabled
							// row as absent, so leaving it disabled would silently discard the value the user
							// just typed.
							enabled: true,
						},
						actor,
					),
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

	// -------------------------------------------------------------------------------------------
	// The raw CRUD half, re-guarded per category
	// -------------------------------------------------------------------------------------------

	/**
	 * The raw row writes, consulted against {@link CATEGORY_PERMISSIONS} before they run.
	 *
	 * Without these overrides the per-category permission would guard exactly one of the two write
	 * paths to the same row: `PATCH …/categories/recordings` would demand `recordings.configure`
	 * while `POST /org-settings { category: "recordings", … }` accepted `settings.write` — and a
	 * permission that one URL enforces and another does not enforces nothing. `update` and
	 * `remove` have to read the row first to learn its category; that is one extra RLS-scoped
	 * SELECT on a write that is already rare, and the read doubles as the 404.
	 */
	override async create(
		session: AppSession,
		values: Record<string, unknown>,
	): Promise<MutationEnvelope<Record<string, unknown>>> {
		this.requireCategoryPermission(
			session,
			typeof values.category === "string" ? values.category : "",
			"write",
		);
		return await super.create(session, values);
	}

	override async update(
		session: AppSession,
		id: string,
		values: Record<string, unknown>,
	): Promise<MutationEnvelope<Record<string, unknown>>> {
		await this.requireRowCategoryPermission(session, id);
		return await super.update(session, id, values);
	}

	override async remove(
		session: AppSession,
		id: string,
	): Promise<MutationEnvelope<{ readonly id: string }>> {
		await this.requireRowCategoryPermission(session, id);
		return await super.remove(session, id);
	}

	// -------------------------------------------------------------------------------------------
	// The user level — /org-settings/me
	// -------------------------------------------------------------------------------------------

	/**
	 * Every user-scoped setting the caller can override, fully resolved for THEM.
	 *
	 * Only the user-scoped names come back: the organization's full categories are already served
	 * by {@link readCategory} under `settings.read`, which every self-service role holds, so the
	 * preferences screen reads the inherited values from there and this answers the narrower
	 * question "what is in force for me". Grouped by category so the response grows a key, not a
	 * shape, when a second category gains a user-scoped setting.
	 */
	async readOwnSettings(session: AppSession): Promise<{
		readonly data: Record<string, Record<string, unknown>>;
	}> {
		const organizationId = this.organizationId(session);
		const userId = session.user.id;
		const data: Record<string, Record<string, unknown>> = {};
		for (const category of USER_SCOPED_CATEGORIES) {
			data[category] = await this.resolveOwnCategory(organizationId, userId, category);
		}
		return { data };
	}

	/**
	 * Saves part of one category's user-scoped settings, for the CALLER and nobody else.
	 *
	 * `userId` is `session.user.id`, unconditionally — it is not a parameter of this method and
	 * not a field of any DTO, which is why the row check here is trivial where
	 * `queue-agent-session.service.ts` needs its `assertMayAct`: that rule compares a row's owner
	 * against the caller because the AGENT ID is an input that can name anybody's seat. Here the
	 * id is not an input, so there is no comparison to get wrong and no row that can belong to
	 * somebody else. `settings.write.own` on the route is the floor; own-ness is structural.
	 *
	 * A name the catalogue does not mark user-scoped is refused by `parseCategoryPatch` with a 400
	 * naming the setting — see the DTO for why refusal beats a row the resolver would ignore.
	 */
	async patchOwnCategory(
		session: AppSession,
		category: string,
		patch: CategoryPatch,
	): Promise<{
		readonly data: Record<string, unknown>;
		readonly category: string;
		readonly written: readonly string[];
	}> {
		const organizationId = this.organizationId(session);
		const userId = session.user.id;
		this.requireCatalogued(category);

		const parsed = parseCategoryPatch(category, patch, { scope: "user" });
		if (parsed.outcome === "invalid") {
			throw new InvalidSettingPatchException(category, parsed.issues);
		}

		const existing = new Map(
			(await this.readUserRows(organizationId, userId, category)).map((row) => [row.name, row]),
		);
		const written: string[] = [];
		const actor = this.actor(session);

		for (const [name, value] of parsed.values) {
			const descriptor = findSetting(category, name);
			if (descriptor === undefined) {
				// Unreachable, narrowed rather than asserted — the same guard `patchCategory` carries.
				continue;
			}
			const row = existing.get(name);
			if (row === undefined) {
				await runEffect(this.runtime, (repository) =>
					repository.create(
						organizationId,
						USER_SETTING_RESOURCE,
						{
							userId,
							category,
							name,
							value,
							valueType: descriptor.valueType,
							enabled: true,
						},
						actor,
					),
				);
			} else {
				await runEffect(this.runtime, (repository) =>
					repository.update(
						organizationId,
						USER_SETTING_RESOURCE,
						row.id,
						{
							value,
							valueType: descriptor.valueType,
							// A save re-enables a disabled row, exactly as at the organization level.
							enabled: true,
						},
						actor,
					),
				);
			}
			written.push(name);
		}

		return {
			category,
			written,
			data: await this.resolveOwnCategory(organizationId, userId, category),
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
		return narrowNotificationSettings(
			resolveCategory(
				NOTIFICATION_SETTINGS_CATEGORY,
				await this.readRows(organizationId, NOTIFICATION_SETTINGS_CATEGORY),
			),
		);
	}

	/**
	 * The same settings with ONE PERSON's overrides applied — the user level's first real consumer.
	 *
	 * Sessionless like {@link readNotificationSettingsFor} and for the same reason: the caller is
	 * the voicemail delivery path acting on a NATS event, and the user id comes from the mailbox's
	 * primary extension user rather than from anybody's session. Only the two user-scoped
	 * presentation settings can differ from the org answer; `resolveForUser` guarantees that, so
	 * this cannot hand the mailer a per-user `fromName` or a per-user Kari's Law list by accident.
	 */
	async readNotificationSettingsForUser(
		organizationId: string,
		userId: string,
	): Promise<NotificationSettings> {
		const [orgRows, userRows] = await Promise.all([
			this.readRows(organizationId, NOTIFICATION_SETTINGS_CATEGORY),
			this.readUserRows(organizationId, userId, NOTIFICATION_SETTINGS_CATEGORY),
		]);
		return narrowNotificationSettings(
			resolveForUser(NOTIFICATION_SETTINGS_CATEGORY, orgRows, userRows),
		);
	}

	/**
	 * The organization's OWN recording retention window in days, or `undefined` when it has never
	 * set one.
	 *
	 * Deliberately NOT `resolveCategory`, and the difference is the whole contract. The resolver
	 * answers "what is the effective value?" and would say `0` for a tenant with no row — the
	 * catalogue default. But this method feeds `RecordingRetentionPolicy`, whose consumer falls
	 * back to the PLATFORM's `CDR_RECORDING_RETENTION_DAYS` when there is no org answer, and a
	 * defaulted `0` would silently override an operator's platform floor with "keep for ever" for
	 * every tenant that never opened the settings screen. So: a present, enabled, schema-valid row
	 * is the tenant's answer (including an explicit `0`, which IS "keep for ever" — the tenant may
	 * out-keep the platform); anything else is `undefined`, meaning "the platform decides".
	 */
	async readRecordingRetentionDays(organizationId: string): Promise<number | undefined> {
		const rows = await this.readRows(organizationId, RECORDING_SETTINGS_CATEGORY);
		const row = rows.find((entry) => entry.name === RECORDING_RETENTION_SETTING && entry.enabled);
		if (row === undefined) {
			return undefined;
		}
		const descriptor = findSetting(RECORDING_SETTINGS_CATEGORY, RECORDING_RETENTION_SETTING);
		const parsed = descriptor?.schema.safeParse(row.value);
		return parsed?.success === true && typeof parsed.data === "number" ? parsed.data : undefined;
	}

	// -------------------------------------------------------------------------------------------
	// Internals
	// -------------------------------------------------------------------------------------------

	private requireCatalogued(category: string): void {
		if (settingsInCategory(category).length === 0) {
			throw new UnknownSettingCategoryException(category);
		}
	}

	/**
	 * The per-category permission check the decorator cannot express.
	 *
	 * `@RequirePermissions` is static metadata — an AND over a request — and the category is a
	 * path parameter, so this is a condition on a VALUE, checked here against
	 * `session.permissions` with `hasPermission`, the exact shape
	 * `queue-agent-session.service.ts` uses and for the stated reason. Only categories with an
	 * override in {@link CATEGORY_PERMISSIONS} are re-checked: for everything else the decorator's
	 * `settings.read`/`settings.write` floor IS the whole rule, and re-evaluating it here would be
	 * the same check twice with two chances to drift.
	 */
	private requireCategoryPermission(
		session: AppSession,
		category: string,
		action: "read" | "write",
	): void {
		const override = CATEGORY_PERMISSIONS[category];
		if (override === undefined) {
			return;
		}
		const required = override[action];
		if (!hasPermission(session.permissions ?? [], required)) {
			throw new SettingCategoryForbiddenException(category, required);
		}
	}

	/** As above, for a write addressed by row id — the row is read to learn its category. */
	private async requireRowCategoryPermission(session: AppSession, id: string): Promise<void> {
		const row = await super.get(session, id);
		this.requireCategoryPermission(
			session,
			typeof row.data.category === "string" ? row.data.category : "",
			"write",
		);
	}

	/** One category's user-scoped settings, resolved through all three levels. */
	private async resolveOwnCategory(
		organizationId: string,
		userId: string,
		category: string,
	): Promise<Record<string, unknown>> {
		const [orgRows, userRows] = await Promise.all([
			this.readRows(organizationId, category),
			this.readUserRows(organizationId, userId, category),
		]);
		const resolved = resolveForUser(category, orgRows, userRows);
		const scoped: Record<string, unknown> = {};
		for (const entry of userScopedSettingsInCategory(category)) {
			scoped[entry.name] = resolved[entry.name];
		}
		return scoped;
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

	/** The third level's rows, on the same terms as {@link readRows} — disabled rows included. */
	private async readUserRows(
		organizationId: string,
		userId: string,
		category: string,
	): Promise<readonly SettingRow[]> {
		return await this.database.withTenantScope(organizationId, async (transaction) =>
			transaction
				.select({
					id: userSetting.id,
					name: userSetting.name,
					value: userSetting.value,
					enabled: userSetting.enabled,
				})
				.from(userSetting)
				.where(and(eq(userSetting.userId, userId), eq(userSetting.category, category))),
		);
	}
}

/**
 * The resolved category, narrowed to the typed shape the mail consumers act on.
 *
 * A free function so the org-level and user-level reads narrow IDENTICALLY — two copies of this
 * would be two places for `voicemailToEmailIncludeLink === true` to drift apart. The element-wise
 * narrowing of the Kari's Law list keeps its original justification: a row written before the
 * catalogue entry existed can still be an array of the wrong thing, and a non-string in the list
 * would become a recipient nothing can deliver to.
 */
function narrowNotificationSettings(resolved: Record<string, unknown>): NotificationSettings {
	return {
		voicemailToEmailEnabled: resolved.voicemailToEmailEnabled === true,
		voicemailToEmailIncludeLink: resolved.voicemailToEmailIncludeLink === true,
		voicemailToEmailIncludeTranscription: resolved.voicemailToEmailIncludeTranscription === true,
		fromName: typeof resolved.fromName === "string" ? resolved.fromName : undefined,
		replyTo: typeof resolved.replyTo === "string" ? resolved.replyTo : undefined,
		emergencyNotificationEmails: Array.isArray(resolved.emergencyNotificationEmails)
			? resolved.emergencyNotificationEmails.filter(
					(entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
				)
			: [],
	};
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
	/** Kari's Law recipients. Empty is the default and means nobody is notified. */
	readonly emergencyNotificationEmails: readonly string[];
}
