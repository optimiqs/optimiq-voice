import { Logger } from "@nestjs/common";
import { fromNodeHeaders } from "better-auth/node";
import { type RawAuthSession, setSessionOnRequest, toAppSession } from "./app-session";
import type { AuthPlatform } from "./auth.platform";
import type { AppSession } from "@optimiq-voice/auth";

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

/** The header `@better-auth/api-key` reads by default, and the one the SDK and CLI will send. */
export const API_KEY_HEADER = "x-api-key";

/**
 * `user.role` on a synthesised API-key session. It is the ADMIN plugin's platform role field, not
 * an organization membership role, so a distinctive value is safe and makes the principal
 * greppable in logs and audit records.
 */
export const API_KEY_PRINCIPAL_ROLE = "api-key";

/**
 * The membership role an API key acts with. `admin`, never `owner`: a programmatic credential
 * must not be able to delete the organization that issued it.
 */
export const API_KEY_MEMBERSHIP_ROLE = "admin";

/** Only used when the key itself has no expiry; nothing is persisted either way. */
const API_KEY_SESSION_TTL_MS = 60 * 60 * 1000;

/** The slice of `auth.api.verifyApiKey`'s response this file depends on. */
interface VerifyApiKeyResult {
	readonly valid: boolean;
	readonly key: {
		readonly id: string;
		readonly name: string | null;
		readonly referenceId: string;
		readonly expiresAt: Date | null;
	} | null;
}

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
 * Three credentials, in order: the session cookie and `Authorization: Bearer` (both handled
 * inside `auth.api.getSession` — the bearer plugin rewrites the header into a cookie before the
 * session lookup), then `x-api-key`.
 *
 * It never rejects: authorization is the guard's job.
 */
export function registerSessionHook(server: AuthHttpServer, platform: AuthPlatform): void {
	const logger = new Logger("AuthSession");
	const resolveApiKeySession = createApiKeySessionResolver(platform);

	server.addHook("preHandler", async (request) => {
		if (isAuthRoute(request.url)) {
			return;
		}
		try {
			const resolved = (await platform.auth.api.getSession({
				headers: fromNodeHeaders(request.headers),
			})) as RawAuthSession | null;
			if (resolved) {
				setSessionOnRequest(request, toAppSession(resolved));
				return;
			}
			setSessionOnRequest(request, await resolveApiKeySession(request));
		} catch (error) {
			logger.warn(`session resolution failed for ${request.method} ${request.url}`, error);
			setSessionOnRequest(request, null);
		}
	});
}

/**
 * `x-api-key` → `AppSession`, the fix for the Step 3 blocker.
 *
 * `@better-auth/api-key@1.6.23` promotes an API key into a session in a `before` hook, but bails
 * out unless the key references a **user** (`dist/index.mjs:2353`):
 *
 * ```js
 * if ((config.references ?? "user") !== "user") {
 *   throw APIError.from("UNAUTHORIZED", API_KEY_ERROR_CODES.INVALID_REFERENCE_ID_FROM_API_KEY);
 * }
 * ```
 *
 * `packages/auth` configures `apiKey({ references: "organization" })` on purpose — a key belongs
 * to the tenant, not to whoever happened to click "create" — so `auth.api.getSession` with an
 * `x-api-key` header returns nothing useful. The plan recorded three options and recommended (a):
 * resolve the key explicitly and synthesise the session here. That is what this does. The data
 * model is untouched, `references: "organization"` keeps its cascade-on-organization-delete, and
 * an API key stays what it actually is — a **tenant** principal with no user behind it.
 *
 * Consequences worth stating, because they are the shape of the abstraction rather than
 * shortcuts:
 *
 * - `session.userId` and `user.id` are the key's id. There is no person; anything that attributes
 *   an action to a human must check `user.email === ""` (or the `apiKey` marker on the session's
 *   `user.role`) rather than assume a `user` row exists behind the id.
 * - `activeOrganizationId` is the key's `referenceId`, which is exactly the tenant claim the
 *   guard and every org-scoped repository need.
 * - The membership role is `admin`, not `owner`: a programmatic credential must not be able to
 *   delete the organization that issued it. `RequirePermissionsGuard` re-resolves permissions
 *   from this role through `role-permissions.ts` like any other caller.
 * - Nothing is written. No `session` row is created for an API-key request, so key traffic cannot
 *   inflate the session table or extend a cookie's life.
 */
export function createApiKeySessionResolver(
	platform: AuthPlatform,
): (request: AuthHttpRequest) => Promise<AppSession | null> {
	const logger = new Logger("AuthApiKey");

	return async (request) => {
		const raw = request.headers[API_KEY_HEADER];
		const presented = (Array.isArray(raw) ? raw[0] : raw)?.trim();
		if (!presented) {
			return null;
		}

		const result = (await platform.auth.api.verifyApiKey({
			body: { key: presented },
		})) as VerifyApiKeyResult;

		if (!result.valid || !result.key) {
			logger.warn(`rejected ${API_KEY_HEADER} for ${request.method} ${pathOf(request.url)}`);
			return null;
		}

		const organizationId = result.key.referenceId;
		if (!organizationId) {
			logger.warn("an API key verified but carries no referenceId; refusing to guess a tenant");
			return null;
		}

		return {
			session: {
				id: result.key.id,
				userId: result.key.id,
				token: "",
				expiresAt: result.key.expiresAt ?? new Date(Date.now() + API_KEY_SESSION_TTL_MS),
				activeOrganizationId: organizationId,
				impersonatedBy: null,
				ipAddress: null,
				userAgent: null,
			},
			user: {
				id: result.key.id,
				email: "",
				name: result.key.name ?? "api-key",
				emailVerified: true,
				image: null,
				role: API_KEY_PRINCIPAL_ROLE,
				banned: false,
				twoFactorEnabled: false,
			},
			activeOrganizationRole: API_KEY_MEMBERSHIP_ROLE,
		};
	};
}

export function registerAuthHttp(server: AuthHttpServer, platform: AuthPlatform): void {
	registerAuthRoutes(server, platform);
	registerSessionHook(server, platform);
}
