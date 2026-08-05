import { AriEventStream } from "./event-stream";
import { AriHttpClient } from "./http-client";
import { AriApplications, AriAsterisk } from "./resources/applications";
import { AriBridges } from "./resources/bridges";
import { AriChannels } from "./resources/channels";
import { AriDeviceStates, AriEndpoints } from "./resources/endpoints";
import { AriPlaybacks } from "./resources/playbacks";
import { AriRecordings } from "./resources/recordings";
import { buildEventsUrl, normalizeAriBaseUrl } from "./url";
import type { BackoffOptions } from "./backoff";
import type { AriEventStreamHandlers, AriStreamStatus } from "./event-stream";
import type { AriFetch } from "./http-client";

/**
 * The ARI client — REST resources plus a factory for the event socket.
 *
 * ## What this package is, and is not
 *
 * It is a PROTOCOL ADAPTER. It knows that hangup causes are integers on a query string, that
 * recordings are addressed by name, that `variables` go in the originate body and not the query,
 * and that an unset channel variable answers `404`. It does not know what a call is.
 *
 * There are no imports of `@optimiq-voice/telephony`, `@optimiq-voice/events` or `nats` here, and
 * there must not be: the point of quarantining ARI is that when `apps/mediad` replaces Asterisk
 * (plan §3.4 option E), the engine's domain code is unchanged and only this package is retired.
 * A domain type leaking in here would make that swap a rewrite.
 */

export interface AriClientOptions {
	/** `http://asterisk:8088` — with or without a trailing `/ari`; both normalise the same way. */
	readonly baseUrl: string;
	readonly username: string;
	readonly password: string;
	/** The Stasis application name the dialplan hands channels to. */
	readonly app: string;
	/**
	 * Whether to receive events for channels outside this application. Default `false`: on a
	 * shared media server, `true` means one engine sees every tenant's channels.
	 */
	readonly subscribeAll?: boolean;
	readonly timeoutMs?: number;
	readonly backoff?: BackoffOptions;
	/** Injection seams for tests. */
	readonly fetch?: AriFetch;
	readonly webSocketFactory?: (url: string) => WebSocket;
}

export class AriClient {
	/** Normalised `<scheme>://<host>[:<port>]/ari`. */
	readonly baseUrl: string;
	readonly app: string;

	readonly channels: AriChannels;
	readonly bridges: AriBridges;
	readonly playbacks: AriPlaybacks;
	readonly recordings: AriRecordings;
	readonly endpoints: AriEndpoints;
	readonly deviceStates: AriDeviceStates;
	readonly applications: AriApplications;
	readonly asterisk: AriAsterisk;

	private readonly options: AriClientOptions;
	private readonly http: AriHttpClient;

	constructor(options: AriClientOptions) {
		this.options = options;
		this.baseUrl = normalizeAriBaseUrl(options.baseUrl);
		this.app = options.app;
		this.http = new AriHttpClient({
			baseUrl: this.baseUrl,
			credentials: { username: options.username, password: options.password },
			timeoutMs: options.timeoutMs,
			fetch: options.fetch,
		});

		this.channels = new AriChannels(this.http);
		this.bridges = new AriBridges(this.http);
		this.playbacks = new AriPlaybacks(this.http);
		this.recordings = new AriRecordings(this.http);
		this.endpoints = new AriEndpoints(this.http);
		this.deviceStates = new AriDeviceStates(this.http);
		this.applications = new AriApplications(this.http);
		this.asterisk = new AriAsterisk(this.http);
	}

	/**
	 * Builds (but does not start) the event stream. Call `start()` on the result.
	 *
	 * Not started here, and not owned by the client, because the socket has a lifecycle the REST
	 * surface does not: it must be started after the consumer's handlers exist and closed before
	 * the process exits, and hiding that inside a constructor is how sockets get leaked in tests.
	 */
	createEventStream(handlers: AriEventStreamHandlers): AriEventStream {
		return new AriEventStream({
			url: buildEventsUrl({
				normalizedBaseUrl: this.baseUrl,
				app: this.app,
				credentials: { username: this.options.username, password: this.options.password },
				subscribeAll: this.options.subscribeAll,
			}),
			handlers,
			backoff: this.options.backoff,
			webSocketFactory: this.options.webSocketFactory,
		});
	}

	/**
	 * Proves the REST endpoint is reachable and the credentials are accepted. Returns the
	 * Asterisk version when it is available.
	 *
	 * Used by the engine's bootstrap so a wrong password fails at start-up rather than on the
	 * first inbound call.
	 */
	async ping(): Promise<{ readonly version?: string }> {
		const info = await this.asterisk.info();
		return { version: info.system?.version };
	}
}

export type { AriStreamStatus };
