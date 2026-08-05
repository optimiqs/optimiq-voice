/**
 * URL and credential assembly for both ARI transports.
 *
 * Everything in this file is pure and total, because it is the part of an ARI client that is
 * easiest to get subtly wrong and impossible to notice until a call fails: a missing `/ari`
 * prefix, a query value that was not percent-encoded, an `https` base that produced a `ws://`
 * socket, credentials leaking into a log line.
 */

/** Values a caller may hand to a query builder. `undefined` means "omit the parameter". */
export type QueryValue = string | number | boolean | undefined;

/** How the adapter proves who it is. */
export interface AriCredentials {
	readonly username: string;
	readonly password: string;
}

/**
 * Normalises a user-supplied ARI base URL to `<scheme>://<host>[:<port>]/ari`.
 *
 * Accepts, and produces the same result for, all of `http://asterisk:8088`,
 * `http://asterisk:8088/`, `http://asterisk:8088/ari` and `http://asterisk:8088/ari/`. The
 * duplicate-`/ari` case is the one that matters: half the deployments in the wild configure the
 * base with it and half without, and `…/ari/ari/channels` returns a 404 that reads like a bug in
 * the call flow.
 *
 * @throws {TypeError} when the value is not an absolute `http`/`https` URL.
 */
export function normalizeAriBaseUrl(baseUrl: string): string {
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch (cause) {
		throw new TypeError(`ARI base URL ${JSON.stringify(baseUrl)} is not an absolute URL.`, {
			cause,
		});
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new TypeError(
			`ARI base URL ${JSON.stringify(baseUrl)} must use http or https, received ${parsed.protocol}.`,
		);
	}

	const trimmed = parsed.pathname.replace(/\/+$/u, "");
	const path = trimmed === "" || trimmed === "/ari" ? "/ari" : `${trimmed}/ari`;
	return `${parsed.origin}${path}`;
}

/** Percent-encodes one path segment. Channel ids contain `.` and, on Local channels, `;`. */
export function encodeSegment(segment: string): string {
	return encodeURIComponent(segment);
}

/**
 * Renders a query string from a sparse record, dropping `undefined` and preserving insertion
 * order so the result is stable enough to assert on in a spec.
 *
 * Repeated parameters are expressed as arrays because ARI's `media` parameter genuinely takes a
 * list (`?media=sound:a&media=sound:b` plays them back to back).
 */
export function buildQuery(
	params: Readonly<Record<string, QueryValue | readonly QueryValue[]>>,
): string {
	const search = new URLSearchParams();

	for (const [key, value] of Object.entries(params)) {
		if (value === undefined) {
			continue;
		}
		if (Array.isArray(value)) {
			for (const item of value as readonly QueryValue[]) {
				if (item !== undefined) {
					search.append(key, String(item));
				}
			}
			continue;
		}
		search.append(key, String(value as QueryValue));
	}

	const rendered = search.toString();
	return rendered === "" ? "" : `?${rendered}`;
}

/** Joins a normalised base with a resource path (`/channels/{id}/answer`) and a query string. */
export function buildRestUrl(
	normalizedBaseUrl: string,
	path: string,
	params: Readonly<Record<string, QueryValue | readonly QueryValue[]>> = {},
): string {
	const suffix = path.startsWith("/") ? path : `/${path}`;
	return `${normalizedBaseUrl}${suffix}${buildQuery(params)}`;
}

/** The `Authorization` header value for ARI's HTTP basic auth. */
export function basicAuthHeader(credentials: AriCredentials): string {
	const encoded = Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64");
	return `Basic ${encoded}`;
}

/**
 * The event-socket URL: `ws(s)://…/ari/events?app=…&subscribeAll=…&api_key=user:pass`.
 *
 * ## Why `api_key` and not an `Authorization` header
 *
 * Node's built-in `WebSocket` implements the WHATWG constructor, which has no way to set request
 * headers on the upgrade — that is a browser security rule Node inherited. ARI's documented
 * alternative is the `api_key=username:password` query parameter, which every Asterisk since 12
 * accepts. It is a real trade-off (the credential lands in the URL), so it is contained: this is
 * the ONLY function that produces it, and {@link redactAriUrl} exists so nothing else ever has an
 * excuse to log the raw string.
 *
 * `subscribeAll=false` is the default on purpose. With it true, one engine instance receives every
 * channel on the box, including channels belonging to other Stasis applications.
 */
export function buildEventsUrl(input: {
	readonly normalizedBaseUrl: string;
	readonly app: string;
	readonly credentials: AriCredentials;
	readonly subscribeAll?: boolean;
}): string {
	const httpUrl = new URL(input.normalizedBaseUrl);
	httpUrl.protocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
	const base = `${httpUrl.origin}${httpUrl.pathname}/events`;
	return `${base}${buildQuery({
		app: input.app,
		subscribeAll: input.subscribeAll ?? false,
		api_key: `${input.credentials.username}:${input.credentials.password}`,
	})}`;
}

/**
 * A log-safe rendering of any ARI URL: credentials in `api_key` and in userinfo are replaced with
 * `redacted`. Use this for every URL that reaches a log line, an error message or a span.
 */
export function redactAriUrl(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return "<invalid-url>";
	}
	if (parsed.searchParams.has("api_key")) {
		parsed.searchParams.set("api_key", "redacted");
	}
	if (parsed.username !== "" || parsed.password !== "") {
		parsed.username = "redacted";
		parsed.password = "";
	}
	return parsed.toString();
}
