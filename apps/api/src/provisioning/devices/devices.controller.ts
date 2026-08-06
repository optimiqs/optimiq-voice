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
import { parseDto } from "../../pbx/shared/dto";
import { listQuerySchema } from "../../pbx/shared/pagination";
import { normalizeMacAddress } from "../catalog/mac";
import {
	createDeviceDto,
	createDeviceKeyDto,
	createDeviceLineDto,
	createDeviceProfileDto,
	createDeviceProfileKeyDto,
	regenerateProvisioningTokenDto,
	updateDeviceDto,
	updateDeviceKeyDto,
	updateDeviceLineDto,
	updateDeviceProfileDto,
	updateDeviceProfileKeyDto,
} from "./devices.dto";
import {
	DeviceKeysService,
	DeviceLinesService,
	DeviceProfileKeysService,
	DeviceProfilesService,
	DevicesService,
} from "./devices.service";
import type { ListQuery } from "../../pbx/shared/pagination";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * Free-text search over a MAC column that stores one spelling.
 *
 * An administrator hunting for a phone types what is printed on its label —
 * `00:15:65:AB:CD` — and the column holds `001565abcd…`, so the raw term matches nothing. Stripping
 * separators and lower-casing a term that looks like a partial MAC makes the search find the row;
 * a term that does not look like one (`Reception`, `T54W`) is passed through untouched so the label
 * and model columns still match it.
 *
 * The test is "at least six characters, and every character is hex or a separator". Six because
 * that is an OUI, which is the shortest fragment worth treating as an address rather than as a
 * word — and `abcdef` being both is a coincidence the label search still covers, since the term is
 * matched against every search column with `OR`.
 */
export function normalizeDeviceSearch(query: ListQuery): ListQuery {
	const search = query.search;
	if (search === undefined) {
		return query;
	}
	const compact = search.replace(/[\s:.-]/gu, "");
	if (compact.length < 6 || !/^[0-9a-fA-F]+$/u.test(compact)) {
		return query;
	}
	return { ...query, search: compact.toLowerCase() };
}

/** `/api/v1/devices` — the MAC-addressed inventory. */
@Controller("api/v1/devices")
export class DevicesController {
	constructor(
		@Inject(DevicesService) private readonly devices: DevicesService,
		@Inject(DeviceLinesService) private readonly lines: DeviceLinesService,
		@Inject(DeviceKeysService) private readonly keys: DeviceKeysService,
	) {}

	@Get()
	@RequirePermissions("devices.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.devices.list(
			session,
			normalizeDeviceSearch(parseDto(listQuerySchema, query ?? {})),
		);
	}

	@Get(":id")
	@RequirePermissions("devices.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.devices.get(session, id);
	}

	/**
	 * Creating a device mints its first provisioning token in the same request.
	 *
	 * `device.provisioning_token` is `NOT NULL`, so a device without one cannot exist — and a
	 * two-step "create then mint" would leave the window in which it has to. Minting here also means
	 * the URL is shown at the one moment the administrator is definitely looking: they have just
	 * described a phone that is sitting on a desk in front of them.
	 *
	 * The response carries `provisioning.token` exactly once, on this response and never again.
	 */
	@Post()
	@RequirePermissions("devices.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.devices.createWithProvisioningToken(session, parseDto(createDeviceDto, body));
	}

	@Patch(":id")
	@RequirePermissions("devices.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.devices.update(session, id, parseDto(updateDeviceDto, body));
	}

	@Delete(":id")
	@RequirePermissions("devices.delete")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.devices.remove(session, id);
	}

	/**
	 * `POST /devices/:id/provisioning-token` — rotate, and reveal once.
	 *
	 * `devices.write` rather than a permission of its own. The registry is at its stated ceiling and
	 * this is not a distinct capability: anybody who can edit a device can already re-point its lines
	 * at another extension, which is a strictly larger change than rotating the URL that delivers
	 * them. A separate `devices.rotate-token` would be a permission that no role could sensibly hold
	 * without `devices.write` — see the report accompanying this change.
	 *
	 * The configuration check runs FIRST. Handing somebody a URL that every phone will get a 503
	 * from is a worse outcome than telling them which variable an operator has to set.
	 */
	@Post(":id/provisioning-token")
	@RequirePermissions("devices.write")
	async regenerateToken(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		this.devices.assertRenderConfigured();
		const options = parseDto(regenerateProvisioningTokenDto, body ?? {});
		return await this.devices.regenerateProvisioningToken(session, id, options);
	}

	// --- lines -----------------------------------------------------------------------------------

	@Get(":id/lines")
	@RequirePermissions("devices.read")
	async listLines(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.lines.list(session, id);
	}

	@Post(":id/lines")
	@RequirePermissions("devices.write")
	async createLine(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.lines.create(session, id, parseDto(createDeviceLineDto, body));
	}

	@Patch(":id/lines/:lineId")
	@RequirePermissions("devices.write")
	async updateLine(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("lineId", ParseUUIDPipe) lineId: string,
		@Body() body: unknown,
	) {
		return await this.lines.update(session, id, lineId, parseDto(updateDeviceLineDto, body));
	}

	@Delete(":id/lines/:lineId")
	@RequirePermissions("devices.write")
	async removeLine(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("lineId", ParseUUIDPipe) lineId: string,
	) {
		return await this.lines.remove(session, id, lineId);
	}

	// --- keys ------------------------------------------------------------------------------------

	@Get(":id/keys")
	@RequirePermissions("devices.read")
	async listKeys(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.keys.list(session, id);
	}

	@Post(":id/keys")
	@RequirePermissions("devices.write")
	async createKey(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.keys.create(session, id, parseDto(createDeviceKeyDto, body));
	}

	@Patch(":id/keys/:keyId")
	@RequirePermissions("devices.write")
	async updateKey(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("keyId", ParseUUIDPipe) keyId: string,
		@Body() body: unknown,
	) {
		return await this.keys.update(session, id, keyId, parseDto(updateDeviceKeyDto, body));
	}

	@Delete(":id/keys/:keyId")
	@RequirePermissions("devices.write")
	async removeKey(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("keyId", ParseUUIDPipe) keyId: string,
	) {
		return await this.keys.remove(session, id, keyId);
	}
}

/**
 * `/api/v1/device-profiles` — reusable key and setting templates.
 *
 * Its own controller rather than a section of the devices one, because a profile is a top-level
 * entity that outlives the devices that reference it: an organization has half a dozen profiles and
 * a few hundred devices, and nesting the small collection under the large one would make "list the
 * profiles" a query that needs a device to start from.
 *
 * Guarded by the same `devices.*` permissions, deliberately. Editing a profile is editing the
 * configuration of every device that uses it — a strictly wider change than editing one device — so
 * a weaker permission would be an escalation, and a separate one would have to be held by every
 * role that holds `devices.write` anyway.
 */
@Controller("api/v1/device-profiles")
export class DeviceProfilesController {
	constructor(
		@Inject(DeviceProfilesService) private readonly profiles: DeviceProfilesService,
		@Inject(DeviceProfileKeysService) private readonly keys: DeviceProfileKeysService,
	) {}

	@Get()
	@RequirePermissions("devices.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.profiles.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("devices.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.profiles.get(session, id);
	}

	@Post()
	@RequirePermissions("devices.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.profiles.create(session, parseDto(createDeviceProfileDto, body));
	}

	@Patch(":id")
	@RequirePermissions("devices.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.profiles.update(session, id, parseDto(updateDeviceProfileDto, body));
	}

	@Delete(":id")
	@RequirePermissions("devices.delete")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.profiles.remove(session, id);
	}

	@Get(":id/keys")
	@RequirePermissions("devices.read")
	async listKeys(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.keys.list(session, id);
	}

	@Post(":id/keys")
	@RequirePermissions("devices.write")
	async createKey(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.keys.create(session, id, parseDto(createDeviceProfileKeyDto, body));
	}

	@Patch(":id/keys/:keyId")
	@RequirePermissions("devices.write")
	async updateKey(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("keyId", ParseUUIDPipe) keyId: string,
		@Body() body: unknown,
	) {
		return await this.keys.update(session, id, keyId, parseDto(updateDeviceProfileKeyDto, body));
	}

	@Delete(":id/keys/:keyId")
	@RequirePermissions("devices.write")
	async removeKey(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("keyId", ParseUUIDPipe) keyId: string,
	) {
		return await this.keys.remove(session, id, keyId);
	}
}

/** Exported for the spec that pins the search normalization. */
export { normalizeMacAddress };
