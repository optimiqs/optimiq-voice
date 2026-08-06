import type { Permission } from "./permissions";

/**
 * The typed client for the REST surface `apps/api` serves alongside better-auth.
 *
 * Everything better-auth already owns (sign-in, organizations, members, invitations, API keys)
 * goes through `./auth-client`; this covers only the application's own `/api/v1/*` controllers.
 * Requests are same-origin and rely on the session cookie, so nothing here handles tokens.
 *
 * The API surface is REST + WebSocket per the master plan §4.4; an OpenAPI-generated SDK will
 * eventually replace these hand-written types. Until the generator exists the shapes are declared
 * here and mirror `apps/api/src/auth/auth.service.ts` — `Date` fields arrive as ISO strings.
 */

export const API_BASE_PATH = "/api/v1";

/**
 * A non-2xx response, carrying the status so callers can branch on 401 / 403 without parsing.
 *
 * `body` is the parsed payload, kept because the PBX area's failure taxonomy is a contract: a 422
 * carries `issues[]` or `diagnostics[]` addressed at form fields, and a 409 carries the rows that
 * refused a delete. Throwing away everything but `message` would force every form to re-fetch
 * information the server already sent, and would put a list of referencing entities into a single
 * string. `lib/pbx/errors.ts` is the only place that reads it.
 */
export class ApiError extends Error {
	readonly status: number;
	readonly body: unknown;

	constructor(status: number, message: string, body: unknown = null) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.body = body;
	}

	/** The caller has no session — the app should send them to sign-in. */
	get isUnauthenticated(): boolean {
		return this.status === 401;
	}

	/** Authenticated but not permitted, or no organization selected. */
	get isForbidden(): boolean {
		return this.status === 403;
	}
}

function messageFrom(payload: unknown, fallback: string): string {
	if (typeof payload === "object" && payload !== null) {
		const { message } = payload as { message?: unknown };
		if (typeof message === "string" && message.length > 0) {
			return message;
		}
		if (Array.isArray(message) && typeof message[0] === "string") {
			return message[0];
		}
	}
	return fallback;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
	const response = await fetch(`${API_BASE_PATH}${path}`, {
		...init,
		credentials: "include",
		headers: {
			accept: "application/json",
			...(init.body === undefined ? {} : { "content-type": "application/json" }),
			...init.headers,
		},
	});

	const text = await response.text();
	let payload: unknown = null;
	if (text.length > 0) {
		try {
			payload = JSON.parse(text);
		} catch {
			payload = text;
		}
	}

	if (!response.ok) {
		throw new ApiError(
			response.status,
			messageFrom(payload, `Request failed (${response.status})`),
			payload,
		);
	}
	return payload as T;
}

// --- Shapes mirrored from apps/api/src/auth ----------------------------------------------------

export interface OrganizationView {
	readonly id: string;
	readonly name: string;
	readonly slug: string | null;
	readonly logo: string | null;
	readonly role: string;
	readonly createdAt: string;
}

export interface SessionOverview {
	readonly user: {
		readonly id: string;
		readonly email: string;
		readonly name: string;
		readonly emailVerified: boolean;
		readonly image: string | null;
		readonly platformRole: string | null;
	};
	readonly session: {
		readonly id: string;
		readonly expiresAt: string;
		readonly impersonated: boolean;
	};
	readonly activeOrganization: OrganizationView | null;
	readonly role: string | null;
	readonly permissions: readonly Permission[];
}

export interface OrganizationMemberSummary {
	readonly id: string;
	readonly userId: string;
	readonly email: string;
	readonly name: string;
	readonly role: string;
	readonly createdAt: string;
}

/**
 * Who the caller is, which organization they are acting in and what that grants them.
 *
 * This — not the better-auth session — is the authority on permissions: the server resolves the
 * membership role through the same role templates the guard uses, so the two can never disagree.
 */
export async function fetchSessionOverview(): Promise<SessionOverview> {
	return await apiFetch<SessionOverview>("/me");
}

export async function fetchMyOrganizations(): Promise<readonly OrganizationView[]> {
	const { data } = await apiFetch<{ data: readonly OrganizationView[] }>("/organizations");
	return data;
}

export async function fetchOrganizationMembers(
	organizationId: string,
): Promise<readonly OrganizationMemberSummary[]> {
	const { data } = await apiFetch<{ data: readonly OrganizationMemberSummary[] }>(
		`/organizations/${organizationId}/members`,
	);
	return data;
}
