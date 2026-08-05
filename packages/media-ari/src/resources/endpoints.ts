import { ariDeviceStateSchema, ariEndpointSchema } from "../models";
import type { AriHttpClient } from "../http-client";
import type { AriDeviceState, AriEndpoint } from "../models";

/**
 * `/ari/endpoints` and `/ari/deviceStates` — read-only presence.
 *
 * Read-only on purpose. Asterisk can also WRITE a device state (`PUT /deviceStates/{name}`), and
 * that is exactly the shortcut this platform must not take: presence is derived from the channel
 * events the engine already owns and published to the `presence` KV bucket, so BLF stays correct
 * when the media server is swapped. Writing state into Asterisk would make Asterisk the authority
 * on something it does not know (queue membership, DND, follow-me).
 */
export class AriEndpoints {
	constructor(private readonly http: AriHttpClient) {}

	/** `GET /endpoints`. */
	async list(): Promise<readonly AriEndpoint[]> {
		return await this.http.requestParsed(
			{ method: "GET", path: "/endpoints" },
			ariEndpointSchema.array(),
		);
	}

	/** `GET /endpoints/{tech}` — every peer of one channel technology (`PJSIP`). */
	async listByTechnology(technology: string): Promise<readonly AriEndpoint[]> {
		return await this.http.requestParsed(
			{ method: "GET", path: `/endpoints/${encodeURIComponent(technology)}` },
			ariEndpointSchema.array(),
		);
	}

	/** `GET /endpoints/{tech}/{resource}` — `undefined` when the peer is not configured. */
	async get(technology: string, resource: string): Promise<AriEndpoint | undefined> {
		return await this.http.requestParsedOptional(
			{
				method: "GET",
				path: `/endpoints/${encodeURIComponent(technology)}/${encodeURIComponent(resource)}`,
			},
			ariEndpointSchema,
		);
	}
}

/** `/ari/deviceStates` — the aggregate hint Asterisk publishes for a device. */
export class AriDeviceStates {
	constructor(private readonly http: AriHttpClient) {}

	/** `GET /deviceStates`. */
	async list(): Promise<readonly AriDeviceState[]> {
		return await this.http.requestParsed(
			{ method: "GET", path: "/deviceStates" },
			ariDeviceStateSchema.array(),
		);
	}

	/** `GET /deviceStates/{name}`. */
	async get(deviceName: string): Promise<AriDeviceState | undefined> {
		return await this.http.requestParsedOptional(
			{ method: "GET", path: `/deviceStates/${encodeURIComponent(deviceName)}` },
			ariDeviceStateSchema,
		);
	}
}
