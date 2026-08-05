import { ariBridgeSchema } from "../models";
import type { AriHttpClient } from "../http-client";
import type { AriBridge } from "../models";

/**
 * `/ari/bridges` — joining legs together.
 *
 * The bridge TYPE is chosen at creation and cannot be changed afterwards, which is why it is a
 * required argument rather than an option with a default:
 *
 * - `mixing` — decodes and mixes every participant. Required for conferences, for recording a
 *   bridge, and for anything that needs to hear the mix (DTMF detection on the mixed stream).
 * - `holding` — participants hear MOH and not each other. Park lots and queue hold live here.
 * - `dtmf_events` — DTMF is emitted as events rather than passed through.
 * - `proxy_media` — media is relayed without decoding: the cheap two-party bridge.
 */
export const ARI_BRIDGE_TYPES = ["mixing", "holding", "dtmf_events", "proxy_media"] as const;

export type AriBridgeType = (typeof ARI_BRIDGE_TYPES)[number];

/** The role a channel takes inside a bridge. Only meaningful for `holding` bridges. */
export type AriBridgeRole = "announcer" | "participant";

export interface CreateBridgeOptions {
	/** One or more types, combined (`["mixing", "dtmf_events"]`). */
	readonly types: readonly AriBridgeType[];
	/** Client-assigned id, so the engine knows the bridge id before the bridge exists. */
	readonly bridgeId?: string;
	readonly name?: string;
}

export class AriBridges {
	constructor(private readonly http: AriHttpClient) {}

	/** `GET /bridges/{id}` — `undefined` when the bridge is already gone. */
	async get(bridgeId: string): Promise<AriBridge | undefined> {
		return await this.http.requestParsedOptional(
			{ method: "GET", path: `/bridges/${encodeURIComponent(bridgeId)}` },
			ariBridgeSchema,
		);
	}

	/** `GET /bridges`. */
	async list(): Promise<readonly AriBridge[]> {
		return await this.http.requestParsed(
			{ method: "GET", path: "/bridges" },
			ariBridgeSchema.array(),
		);
	}

	/** `POST /bridges` — create a bridge of the given type(s). */
	async create(options: CreateBridgeOptions): Promise<AriBridge> {
		return await this.http.requestParsed(
			{
				method: "POST",
				path: "/bridges",
				query: {
					type: options.types.join(","),
					bridgeId: options.bridgeId,
					name: options.name,
				},
			},
			ariBridgeSchema,
		);
	}

	/** `POST /bridges/{id}/addChannel` — join one or more channels to the bridge. */
	async addChannels(
		bridgeId: string,
		channelIds: readonly string[],
		options: {
			readonly role?: AriBridgeRole;
			readonly absorbDtmf?: boolean;
			readonly mute?: boolean;
		} = {},
	): Promise<void> {
		await this.http.requestVoid({
			method: "POST",
			path: `/bridges/${encodeURIComponent(bridgeId)}/addChannel`,
			query: {
				channel: channelIds,
				role: options.role,
				absorbDTMF: options.absorbDtmf,
				mute: options.mute,
			},
		});
	}

	/** `POST /bridges/{id}/removeChannel` — separate channels without hanging them up. */
	async removeChannels(bridgeId: string, channelIds: readonly string[]): Promise<void> {
		await this.http.requestVoid({
			method: "POST",
			path: `/bridges/${encodeURIComponent(bridgeId)}/removeChannel`,
			query: { channel: channelIds },
			tolerateNotFound: true,
		});
	}

	/**
	 * `DELETE /bridges/{id}` — destroy the bridge. Channels in it are ejected, not hung up.
	 *
	 * A `404` is tolerated: Asterisk destroys an empty two-party bridge on its own, so the engine
	 * racing it is the normal case.
	 */
	async destroy(bridgeId: string): Promise<void> {
		await this.http.requestVoid({
			method: "DELETE",
			path: `/bridges/${encodeURIComponent(bridgeId)}`,
			tolerateNotFound: true,
		});
	}

	/** `POST /bridges/{id}/moh` — serve MOH to a holding bridge. */
	async startMoh(bridgeId: string, mohClass?: string): Promise<void> {
		await this.http.requestVoid({
			method: "POST",
			path: `/bridges/${encodeURIComponent(bridgeId)}/moh`,
			query: { mohClass },
		});
	}

	/** `DELETE /bridges/{id}/moh`. */
	async stopMoh(bridgeId: string): Promise<void> {
		await this.http.requestVoid({
			method: "DELETE",
			path: `/bridges/${encodeURIComponent(bridgeId)}/moh`,
		});
	}
}
