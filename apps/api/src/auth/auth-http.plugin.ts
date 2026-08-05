import { Logger } from "@nestjs/common";
import { fromNodeHeaders } from "better-auth/node";
import { type RawAuthSession, setSessionOnRequest, toAppSession } from "./app-session";
import type { AuthPlatform } from "./auth.platform";

/**
 * The better-auth HTTP mount and the session `preHandler` hook.
 *
 * Mount mechanism: a raw Fastify route at `/api/auth/*` that converts the Fastify request into a
 * WHATWG `Request`, hands it to `auth.handler(request)` and writes the `Response` back. This is
 * better-auth 1.6.23's documented Fastify integration. `toNodeHandler` (from `better-auth/node`)
 * is deliberately NOT used: it writes to the raw `ServerResponse` behind Fastify's back, which
 * breaks reply lifecycle hooks and `onSend` security headers.
 *
 * Registration happens in `main.ts` after `NestFactory.create` and before `listen`, so these
 * routes and hooks exist before Nest installs its own router and 404 handler.
 */

export const AUTH_ROUTE_PREFIX = "/api/auth";

/**
 * The slice of Fastify this file uses. Typed structurally so `apps/api` does not need a direct
 * `fastify` dependency alongside `@nestjs/platform-fastify`'s own copy.
 */
export interface AuthHttpRequest {
	readonly method: string;
	readonly url: string;
	readonly headers: Record<string, string | string[] | undefined>;
	readonly body?: unknown;
}

export interface AuthHttpReply {
	status(statusCode: number): AuthHttpReply;
	header(key: string, value: string | readonly string[]): AuthHttpReply;
	send(payload?: unknown): unknown;
}

export interface AuthHttpServer {
	route(options: {
		method: readonly string[];
		url: string;
		handler: (request: AuthHttpRequest, reply: AuthHttpReply) => Promise<void>;
	}): unknown;
	addHook(
		name: "preHandler",
		hook: (request: AuthHttpRequest, reply: AuthHttpReply) => Promise<void>,
	): unknown;
}

const HANDLED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const;

function pathOf(url: string): string {
	const queryIndex = url.indexOf("?");
	return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

function isAuthRoute(url: string): boolean {
	const path = pathOf(url);
	return path === AUTH_ROUTE_PREFIX || path.startsWith(`${AUTH_ROUTE_PREFIX}/`);
}

function toRequestUrl(request: AuthHttpRequest, baseURL: string): URL {
	const forwardedHost = request.headers.host;
	const host = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost;
	const origin = host ? `http://${host}` : baseURL;
	return new URL(request.url, origin);
}

/**
 * Fastify has already parsed the body by the time the handler runs, so it is re-serialized in
 * the encoding the caller announced. better-auth speaks JSON on every endpoint; form encoding is
 * handled for OAuth-style callbacks.
 */
function toRequestBody(request: AuthHttpRequest): BodyInit | undefined {
	if (request.method === "GET" || request.method === "HEAD" || request.body === undefined) {
		return undefined;
	}
	if (typeof request.body === "string") {
		return request.body;
	}
	if (request.body instanceof Buffer) {
		return new Uint8Array(request.body);
	}

	const rawContentType = request.headers["content-type"];
	const contentType = Array.isArray(rawContentType) ? rawContentType[0] : rawContentType;
	if (contentType?.includes("application/x-www-form-urlencoded")) {
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(request.body as Record<string, unknown>)) {
			params.append(key, String(value));
		}
		return params.toString();
	}
	return JSON.stringify(request.body);
}

async function writeResponse(reply: AuthHttpReply, response: Response): Promise<void> {
	reply.status(response.status);

	const setCookies = response.headers.getSetCookie();
	if (setCookies.length > 0) {
		reply.header("set-cookie", setCookies);
	}
	response.headers.forEach((value, key) => {
		if (key.toLowerCase() !== "set-cookie") {
			reply.header(key, value);
		}
	});

	const payload = await response.text();
	reply.send(payload.length > 0 ? payload : null);
}

/** Mounts `/api/auth/*` on the Fastify instance. */
export function registerAuthRoutes(server: AuthHttpServer, platform: AuthPlatform): void {
	const logger = new Logger("AuthHttp");

	server.route({
		method: [...HANDLED_METHODS],
		url: `${AUTH_ROUTE_PREFIX}/*`,
		handler: async (request, reply) => {
			try {
				const url = toRequestUrl(request, platform.config.baseURL);
				const init: RequestInit = {
					method: request.method,
					headers: fromNodeHeaders(request.headers),
				};
				const body = toRequestBody(request);
				if (body !== undefined) {
					init.body = body;
				}
				const response = await platform.auth.handler(new Request(url, init));
				await writeResponse(reply, response);
			} catch (error) {
				logger.error(`better-auth handler failed for ${request.method} ${request.url}`, error);
				reply.status(500).send({ statusCode: 500, error: "Internal Server Error" });
			}
		},
	});
}

/**
 * Resolves the caller once per request and stores it on the request.
 *
 * `auth.api.getSession` accepts the cookie, the `Authorization: Bearer` header (bearer plugin)
 * and the API-key header (apiKey plugin), so this is the single authentication point for every
 * non-`/api/auth` route. It never rejects: authorization is the guard's job.
 */
export function registerSessionHook(server: AuthHttpServer, platform: AuthPlatform): void {
	const logger = new Logger("AuthSession");

	server.addHook("preHandler", async (request) => {
		if (isAuthRoute(request.url)) {
			return;
		}
		try {
			const resolved = (await platform.auth.api.getSession({
				headers: fromNodeHeaders(request.headers),
			})) as RawAuthSession | null;
			setSessionOnRequest(request, resolved ? toAppSession(resolved) : null);
		} catch (error) {
			logger.warn(`session resolution failed for ${request.method} ${request.url}`, error);
			setSessionOnRequest(request, null);
		}
	});
}

export function registerAuthHttp(server: AuthHttpServer, platform: AuthPlatform): void {
	registerAuthRoutes(server, platform);
	registerSessionHook(server, platform);
}
