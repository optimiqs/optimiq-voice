import { ariApplicationSchema, ariAsteriskInfoSchema } from "../models";
import type { AriHttpClient } from "../http-client";
import type { AriApplication, AriAsteriskInfo } from "../models";

/**
 * The event sources a Stasis application can subscribe to beyond its own channels.
 *
 * Format is `<kind>:<id>`, e.g. `endpoint:PJSIP/1001`, `deviceState:Custom:queue-sales`,
 * `bridge:<id>`, `channel:<id>`.
 */
export type AriEventSource = string;

/**
 * `/ari/applications` and `/ari/asterisk` — the application's own registration and the box's
 * identity.
 *
 * Subscription is the counterpart of `subscribeAll=false` on the event socket: the engine opens a
 * narrow socket and then asks for exactly the extra sources it needs (an endpoint whose presence
 * it must publish, a bridge it did not create). Opening a wide socket instead means one engine
 * instance receives every channel on a shared media server, including other tenants' Stasis apps.
 */
export class AriApplications {
	constructor(private readonly http: AriHttpClient) {}

	/** `GET /applications/{name}` — `undefined` when the application is not registered. */
	async get(applicationName: string): Promise<AriApplication | undefined> {
		return await this.http.requestParsedOptional(
			{ method: "GET", path: `/applications/${encodeURIComponent(applicationName)}` },
			ariApplicationSchema,
		);
	}

	/** `GET /applications`. */
	async list(): Promise<readonly AriApplication[]> {
		return await this.http.requestParsed(
			{ method: "GET", path: "/applications" },
			ariApplicationSchema.array(),
		);
	}

	/** `POST /applications/{name}/subscription`. */
	async subscribe(
		applicationName: string,
		eventSources: readonly AriEventSource[],
	): Promise<AriApplication> {
		return await this.http.requestParsed(
			{
				method: "POST",
				path: `/applications/${encodeURIComponent(applicationName)}/subscription`,
				query: { eventSource: eventSources.join(",") },
			},
			ariApplicationSchema,
		);
	}

	/** `DELETE /applications/{name}/subscription`. */
	async unsubscribe(
		applicationName: string,
		eventSources: readonly AriEventSource[],
	): Promise<AriApplication> {
		return await this.http.requestParsed(
			{
				method: "DELETE",
				path: `/applications/${encodeURIComponent(applicationName)}/subscription`,
				query: { eventSource: eventSources.join(",") },
			},
			ariApplicationSchema,
		);
	}
}

/** `/ari/asterisk` — enough of the box's identity for a health probe to be meaningful. */
export class AriAsterisk {
	constructor(private readonly http: AriHttpClient) {}

	/** `GET /asterisk/info` — proves credentials work and the REST API is serving. */
	async info(): Promise<AriAsteriskInfo> {
		return await this.http.requestParsed(
			{ method: "GET", path: "/asterisk/info" },
			ariAsteriskInfoSchema,
		);
	}
}
