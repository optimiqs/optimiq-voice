import {
	Body,
	Controller,
	Delete,
	Get,
	Inject,
	Param,
	ParseUUIDPipe,
	Patch,
	Post,
	Query,
} from "@nestjs/common";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { parseDto } from "../shared/dto";
import { listQuerySchema } from "../shared/pagination";
import { toWireCatalog } from "./org-settings.catalog";
import { categoryPatchDto, createOrgSettingDto, updateOrgSettingDto } from "./org-settings.dto";
import { OrgSettingsService } from "./org-settings.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/org-settings` — the organization settings cascade.
 *
 * ## The permissions
 *
 * | Route                              | Permission (floor)    |
 * | ---------------------------------- | --------------------- |
 * | `GET …/catalog`                    | `settings.read`       |
 * | `GET …/me`                         | `settings.read.own`   |
 * | `PATCH …/me/categories/:category`  | `settings.write.own`  |
 * | `GET …/categories/:category`       | `settings.read`       |
 * | `PATCH …/categories/:category`     | `settings.write`      |
 * | `GET …` / `GET …/:id`              | `settings.read`       |
 * | `POST …` / `PATCH …/:id` / `DELETE`| `settings.write`      |
 *
 * `settings.write` and not a new `org-settings.*` pair: the registry already declares
 * `settings.read` / `settings.write` / `settings.write.all` for exactly "the organization settings
 * cascade and platform defaults", which is this table. `settings.write.all` is deliberately NOT
 * used here — it means platform-operator defaults that apply to every organization, and nothing in
 * this controller can write outside one tenant.
 *
 * "Floor" is now the accurate word rather than a hedge, twice over. The category routes consult
 * `CATEGORY_PERMISSIONS` in the service — `recordings` demands `recordings.configure` on write —
 * because a decorator is static metadata and the category is a path parameter; see the map's own
 * header. And the `…/me` routes hold the `.own` pair as their floor while own-ness itself is
 * structural: the service writes `userId: session.user.id` and takes no user id from anywhere, so
 * there is no row check to pass or fail. `settings.read.own` rather than `settings.read` on
 * `GET …/me` because reading YOUR overrides is exactly what the narrower grant means, and a role
 * built for machine callers could legitimately hold the org read without the personal one.
 *
 * There is no `settings.delete` in the registry, so removing a row takes `settings.write`. That is
 * the right shape rather than an omission: deleting an `org_setting` row does not destroy data, it
 * reverts the setting to the platform default, which is the same class of act as changing it.
 *
 * ## Route order
 *
 * `catalog`, `me` and `categories` are declared before `:id`, which is a `ParseUUIDPipe`.
 * Fastify's radix router prefers a static segment over a parametric one regardless of declaration
 * order (the property `VoicemailMessagesController` relies on for its media route), so the order
 * here is for the reader rather than the router — but it is the order that would also be correct
 * under a router that resolved by declaration. `me/categories/:category` additionally has two
 * literal leading segments, the shape `queue-agent-session.controller.ts` chose for `session/me`
 * so that no ordering of controllers could ever let a parametric route capture it.
 */
@Controller("api/v1/org-settings")
export class OrgSettingsController {
	constructor(@Inject(OrgSettingsService) private readonly settings: OrgSettingsService) {}

	/**
	 * What settings exist, what type each is and what the platform default is.
	 *
	 * Static data — it describes the schema, not the tenant — so it needs a session and
	 * `settings.read` and nothing else. This is what lets a settings form render a checkbox for a
	 * boolean and a text input for a string without hard-coding the list in `apps/web`.
	 */
	@Get("catalog")
	@RequirePermissions("settings.read")
	catalog() {
		return { data: toWireCatalog() };
	}

	/**
	 * The caller's own preferences — every user-scoped setting, resolved through all three levels.
	 *
	 * The fourth prerequisite `settings-schema.ts` named for `user_setting`'s return: the surface.
	 */
	@Get("me")
	@RequirePermissions("settings.read.own")
	async readOwn(@Session() session: AppSession) {
		return await this.settings.readOwnSettings(session);
	}

	/**
	 * Saves part of one category of the caller's own preferences.
	 *
	 * A setting the catalogue does not mark user-scoped is a 400 naming the setting; whose row is
	 * written is not negotiable — see the service, and the class header for why `.own` is a floor
	 * rather than the whole rule.
	 */
	@Patch("me/categories/:category")
	@RequirePermissions("settings.write.own")
	async patchOwnCategory(
		@Session() session: AppSession,
		@Param("category") category: string,
		@Body() body: unknown,
	) {
		return await this.settings.patchOwnCategory(
			session,
			category,
			parseDto(categoryPatchDto, body ?? {}),
		);
	}

	@Get("categories/:category")
	@RequirePermissions("settings.read")
	async readCategory(@Session() session: AppSession, @Param("category") category: string) {
		return await this.settings.readCategory(session, category);
	}

	/**
	 * Saves part of a category.
	 *
	 * `PATCH` and not `PUT`: an absent key means "leave it alone", which is the same contract every
	 * other write in this area has. A `PUT` would mean "these are all my settings now", and a form
	 * that only renders the notification section would then silently clear the routing one.
	 */
	@Patch("categories/:category")
	@RequirePermissions("settings.write")
	async patchCategory(
		@Session() session: AppSession,
		@Param("category") category: string,
		@Body() body: unknown,
	) {
		return await this.settings.patchCategory(
			session,
			category,
			parseDto(categoryPatchDto, body ?? {}),
		);
	}

	@Get()
	@RequirePermissions("settings.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.settings.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("settings.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.settings.get(session, id);
	}

	@Post()
	@RequirePermissions("settings.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.settings.create(session, parseDto(createOrgSettingDto, body));
	}

	@Patch(":id")
	@RequirePermissions("settings.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.settings.update(session, id, parseDto(updateOrgSettingDto, body));
	}

	/** Removing a row reverts the setting to its platform default. See the class header. */
	@Delete(":id")
	@RequirePermissions("settings.write")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.settings.remove(session, id);
	}
}
