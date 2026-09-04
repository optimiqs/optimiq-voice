import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, bearer, jwt, openAPI, organization, twoFactor } from "better-auth/plugins";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { createEntityId } from "@optimiq-voice/identifiers";
import {
	buildOrganizationAccessControl,
	DEFAULT_ORGANIZATION_CREATOR_ROLE,
} from "./access-control";
import { authSchema } from "./schema";
import { createSessionOrganizationHook, type SessionOrganizationRepository } from "./session";
import type { SystemRoleId } from "./permissions";

/**
 * better-auth 1.6.23 composition for Optimiq Voice.
 *
 * better-auth is a plain dependency here — it is deliberately NOT vendored. Nothing in this
 * package patches library internals, so the version bump path is a catalog edit plus a
 * regenerated migration.
 *
 * Tenancy: an `organization` IS a tenant. `session.activeOrganizationId` is the claim that
 * selects the row-level-security scope in @optimiq-voice/db.
 */

/** Bumping this invalidates every cached session cookie in one deploy. */
export const SESSION_COOKIE_CACHE_VERSION = "session-v1";

export const DEFAULT_SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 12;
export const DEFAULT_SESSION_UPDATE_AGE_SECONDS = 60 * 60;
export const DEFAULT_SESSION_COOKIE_CACHE_SECONDS = 60 * 5;
export const DEFAULT_INVITATION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 7;
export const DEFAULT_JWT_EXPIRES_IN = "15m";

/** The organization membership roles better-auth stores on `member.role`. */
export const ORGANIZATION_MEMBERSHIP_ROLES = ["owner", "admin", "member"] as const;
export type OrganizationMembershipRole = (typeof ORGANIZATION_MEMBERSHIP_ROLES)[number];

type DrizzleAdapterDatabase = Parameters<typeof drizzleAdapter>[0];

export interface AuthMailRecipient {
	readonly id: string;
	readonly email: string;
	readonly name?: string;
}

/**
 * Transport-free delivery hooks. This package never binds SMTP, a provider SDK or templates —
 * the host application injects them, which keeps @optimiq-voice/auth importable from tests and
 * from the migration tooling without any mail configuration.
 */
export interface AuthEmailDelivery {
	readonly sendVerification: (input: {
		readonly user: AuthMailRecipient;
		readonly url: string;
		readonly token: string;
	}) => Promise<void>;
	readonly sendReset: (input: {
		readonly user: AuthMailRecipient;
		readonly url: string;
		readonly token: string;
	}) => Promise<void>;
	readonly sendInvite: (input: {
		readonly email: string;
		readonly invitationId: string;
		readonly organizationName: string;
		readonly inviterEmail: string;
		readonly role: string | undefined;
		readonly acceptUrl: string;
	}) => Promise<void>;
	/**
	 * The second factor's one-time code, delivered out of band.
	 *
	 * Optional, and its presence is load-bearing rather than decorative: better-auth's `twoFactor`
	 * plugin only wires its `otp` sub-adapter when `otpOptions.sendOTP` is supplied, so a host that
	 * omits this gets TOTP and backup codes and no email path — which is the correct behaviour for
	 * a host with no transport, because `POST /two-factor/send-otp` would otherwise mint a code
	 * nobody can receive and answer 200.
	 */
	readonly sendTwoFactorOtp?: (input: {
		readonly user: AuthMailRecipient;
		readonly otp: string;
	}) => Promise<void>;
}

export interface AuthJwtOptions {
	/** EdDSA (Ed25519) by default; RS256 when a consumer cannot verify EdDSA. */
	readonly algorithm?: "EdDSA" | "RS256" | "ES256" | "ES512" | "PS256";
	readonly issuer?: string;
	readonly audience?: string | readonly string[];
	/** jose time span, e.g. `"15m"`, `"30s"` for per-call tokens. */
	readonly expiresIn?: string | number;
	readonly rotationIntervalSeconds?: number;
}

export interface AuthCookieOptions {
	readonly prefix?: string;
	readonly sameSite?: "lax" | "strict" | "none";
	readonly secure?: boolean;
	/** Set to share the session across `app.` / `api.` subdomains. */
	readonly crossSubDomain?: string;
}

export interface CreateAuthOptions {
	/** Drizzle handle. Pass the untenanted `adminDb` — better-auth owns non org-scoped tables. */
	readonly database: DrizzleAdapterDatabase;
	readonly secret: string;
	readonly baseURL: string;
	/** Where the invite accept + password reset links point. */
	readonly appURL: string;
	readonly appName?: string;
	readonly trustedOrigins?: readonly string[];
	readonly email: AuthEmailDelivery;
	/**
	 * Resolves which organization a new session should be scoped to. Without it a session is
	 * created with no tenant claim and the caller must select an organization explicitly.
	 */
	readonly organizationRepository?: SessionOrganizationRepository;
	readonly cookies?: AuthCookieOptions;
	readonly sessionExpiresInSeconds?: number;
	readonly sessionCookieCacheSeconds?: number;
	readonly invitationExpiresInSeconds?: number;
	readonly jwt?: AuthJwtOptions;
	readonly rateLimitEnabled?: boolean;
	/** Serves the auth OpenAPI document at `/api/auth/reference`. */
	readonly openApiEnabled?: boolean;
	readonly requireEmailVerification?: boolean;
	/**
	 * Registers the five `SYSTEM_ROLE_TEMPLATES` with the organization plugin's access control,
	 * making `manager` / `agent` / `user` assignable as `member.role` alongside better-auth's own
	 * `owner` / `admin` / `member`. Enabled by default — turning it off restores the plugin's
	 * three built-in roles and nothing else.
	 */
	readonly organizationRoles?: boolean | { readonly creatorRole?: SystemRoleId };
	/**
	 * The OIDC identity providers to register for federated sign-in, read from the enabled rows in
	 * `organization_sso_provider` at boot.
	 *
	 * These become `genericOAuth` provider configs, which is what makes the SSO surface LIVE rather
	 * than merely stored: with them registered, `/api/auth/sign-in/oauth2` starts a login against a
	 * provider and `/api/auth/oauth2/callback/:providerId` completes it — the same catch-all that
	 * serves email/password forwards both, and the same `databaseHooks.session.create.before` stamps
	 * the tenant claim on the session it issues. Empty (or omitted) registers no `genericOAuth` plugin
	 * at all, which is the pre-wiring behaviour.
	 *
	 * The set is a boot-time snapshot: `genericOAuth`'s config is fixed at `betterAuth()` construction,
	 * so a provider added through the CRUD API takes effect on the next process start. That is the
	 * `genericOAuth` model (better-auth's DB-backed dynamic `sso` plugin is a separate, not-installed
	 * package); the CRUD surface and this feed together make configured-at-boot providers work
	 * end-to-end, which is the honest scope.
	 */
	readonly ssoProviders?: readonly SsoProviderConfig[];
}

/** One OIDC provider, as the auth boot hands it to `genericOAuth`. */
export interface SsoProviderConfig {
	/** The slug in the callback URL: `/api/auth/oauth2/callback/<providerId>`. */
	readonly providerId: string;
	readonly clientId: string;
	readonly clientSecret: string;
	/** The issuer; the discovery document is derived from it when `discoveryUrl` is absent. */
	readonly issuer: string;
	readonly discoveryUrl?: string;
	/** Defaults to `openid email profile` when the provider row named none. */
	readonly scopes?: readonly string[];
}

const DEFAULT_SSO_SCOPES = ["openid", "email", "profile"] as const;

/** Map the stored provider set to `genericOAuth`'s config, filling the OIDC defaults. */
function buildGenericOAuthConfig(providers: readonly SsoProviderConfig[]) {
	return providers.map((provider) => ({
		providerId: provider.providerId,
		clientId: provider.clientId,
		clientSecret: provider.clientSecret,
		issuer: provider.issuer,
		discoveryUrl:
			provider.discoveryUrl ??
			`${provider.issuer.replace(/\/+$/u, "")}/.well-known/openid-configuration`,
		scopes: [
			...(provider.scopes && provider.scopes.length > 0 ? provider.scopes : DEFAULT_SSO_SCOPES),
		],
		// PKCE for every provider: it is a strict security improvement and every modern OIDC IdP
		// supports it, so there is no reason to make it a per-provider toggle.
		pkce: true,
	}));
}

function resolveKeyPairConfig(algorithm: NonNullable<AuthJwtOptions["algorithm"]>) {
	switch (algorithm) {
		case "RS256":
			return { alg: "RS256" } as const;
		case "PS256":
			return { alg: "PS256" } as const;
		case "ES256":
			return { alg: "ES256" } as const;
		case "ES512":
			return { alg: "ES512" } as const;
		default:
			return { alg: "EdDSA", crv: "Ed25519" } as const;
	}
}

function buildJwtPluginOptions(options: AuthJwtOptions | undefined) {
	return {
		jwks: {
			keyPairConfig: resolveKeyPairConfig(options?.algorithm ?? "EdDSA"),
			...(options?.rotationIntervalSeconds === undefined
				? {}
				: { rotationInterval: options.rotationIntervalSeconds }),
		},
		jwt: {
			expirationTime: options?.expiresIn ?? DEFAULT_JWT_EXPIRES_IN,
			...(options?.issuer === undefined ? {} : { issuer: options.issuer }),
			...(options?.audience === undefined
				? {}
				: {
						audience:
							typeof options.audience === "string" ? options.audience : [...options.audience],
					}),
			/**
			 * Service and per-call tokens carry the tenant claim so a downstream verifier
			 * (engine, mediad, provisioning endpoint) can scope without a database round trip.
			 */
			definePayload: (session: {
				user: Record<string, unknown> & { id: string };
				session: Record<string, unknown>;
			}) => ({
				sub: session.user.id,
				email: session.user.email,
				organizationId: session.session.activeOrganizationId ?? null,
			}),
		},
	};
}

/**
 * Composes the better-auth instance.
 *
 * Plugin roles:
 * - `organization` — the tenant model (organizations, members, invitations) with the five
 *   `SYSTEM_ROLE_TEMPLATES` registered as access-control roles (see `./access-control.ts`)
 * - `apiKey`       — organization-scoped programmatic credentials (`@better-auth/api-key`)
 * - `admin`        — platform-operator surface: ban, impersonate, list users
 * - `twoFactor`    — TOTP + backup codes
 * - `jwt`          — asymmetric service and per-call tokens, JWKS published for verifiers
 * - `bearer`       — accepts `Authorization: Bearer <session token>` for non-browser clients
 * - `openAPI`      — machine-readable description of the auth surface
 */
export function createAuth(options: CreateAuthOptions) {
	const sessionExpiresIn = options.sessionExpiresInSeconds ?? DEFAULT_SESSION_EXPIRES_IN_SECONDS;
	const organizationHook = options.organizationRepository
		? createSessionOrganizationHook(options.organizationRepository)
		: undefined;

	// Captured once so the plugin's option object can be built conditionally without re-reading a
	// possibly-undefined member inside the callback.
	const sendTwoFactorOtp = options.email.sendTwoFactorOtp;

	const rolesOption = options.organizationRoles ?? true;
	const accessControl = rolesOption === false ? undefined : buildOrganizationAccessControl();
	const creatorRole =
		(typeof rolesOption === "object" ? rolesOption.creatorRole : undefined) ??
		DEFAULT_ORGANIZATION_CREATOR_ROLE;

	return betterAuth({
		appName: options.appName ?? "Optimiq Voice",
		secret: options.secret,
		baseURL: options.baseURL,
		database: drizzleAdapter(options.database, {
			provider: "pg",
			schema: authSchema,
		}),

		emailAndPassword: {
			enabled: true,
			requireEmailVerification: options.requireEmailVerification ?? true,
			sendResetPassword: async ({ user, url, token }) => {
				await options.email.sendReset({
					user: { id: user.id, email: user.email, name: user.name },
					url,
					token,
				});
			},
		},

		emailVerification: {
			sendOnSignUp: true,
			autoSignInAfterVerification: true,
			sendVerificationEmail: async ({ user, url, token }) => {
				await options.email.sendVerification({
					user: { id: user.id, email: user.email, name: user.name },
					url,
					token,
				});
			},
		},

		session: {
			expiresIn: sessionExpiresIn,
			updateAge: DEFAULT_SESSION_UPDATE_AGE_SECONDS,
			cookieCache: {
				enabled: true,
				maxAge: options.sessionCookieCacheSeconds ?? DEFAULT_SESSION_COOKIE_CACHE_SECONDS,
			},
		},

		...(organizationHook
			? {
					databaseHooks: {
						session: {
							create: {
								before: organizationHook,
							},
						},
					},
				}
			: {}),

		rateLimit: { enabled: options.rateLimitEnabled ?? true },

		trustedOrigins: [...(options.trustedOrigins ?? [])],

		advanced: {
			// UUID v7 everywhere: sortable by creation time and consistent with every other entity.
			database: { generateId: () => createEntityId() },
			cookiePrefix: options.cookies?.prefix ?? `optimiq_voice_${SESSION_COOKIE_CACHE_VERSION}`,
			useSecureCookies: options.cookies?.secure ?? options.baseURL.startsWith("https://"),
			defaultCookieAttributes: {
				sameSite: options.cookies?.sameSite ?? "lax",
				httpOnly: true,
			},
			...(options.cookies?.crossSubDomain
				? {
						crossSubDomainCookies: {
							enabled: true,
							domain: options.cookies.crossSubDomain,
						},
					}
				: {}),
		},

		plugins: [
			organization({
				creatorRole,
				...(accessControl ? { ac: accessControl.ac, roles: accessControl.roles } : {}),
				invitationExpiresIn:
					options.invitationExpiresInSeconds ?? DEFAULT_INVITATION_EXPIRES_IN_SECONDS,
				requireEmailVerificationOnInvitation: true,
				cancelPendingInvitationsOnReInvite: true,
				sendInvitationEmail: async (data) => {
					await options.email.sendInvite({
						email: data.email,
						invitationId: data.id,
						organizationName: data.organization.name,
						inviterEmail: data.inviter.user.email,
						role: data.role,
						acceptUrl: `${options.appURL.replace(/\/+$/u, "")}/accept-invitation/${data.id}`,
					});
				},
			}),
			apiKey({
				// Keys belong to the organization, not to the person who happened to create them.
				references: "organization",
				defaultPrefix: "ovk_",
				enableMetadata: true,
				requireName: true,
			}),
			admin(),
			twoFactor({
				issuer: options.appName ?? "Optimiq Voice",
				/**
				 * `otpOptions.sendOTP` — the plugin's own option name, and the only way to reach the
				 * `otp` sub-adapter. Registered only when the host supplied a sender, for the reason
				 * `AuthEmailDelivery.sendTwoFactorOtp` records.
				 */
				...(sendTwoFactorOtp === undefined
					? {}
					: {
							otpOptions: {
								sendOTP: async (data) => {
									/**
									 * `UserWithTwoFactor.email` is typed optional by the plugin, so the guard
									 * is a type narrowing and a real one at once: a user row with no address
									 * has nowhere to receive a code, and inventing a recipient would be
									 * worse than not sending. Returning without sending leaves the OTP
									 * unusable, which is the correct outcome for an account that cannot
									 * receive it — the other factors (TOTP, backup codes) are unaffected.
									 */
									const email = data.user.email;
									if (typeof email !== "string" || email.length === 0) {
										return;
									}
									await sendTwoFactorOtp({
										user: { id: data.user.id, email, name: data.user.name },
										otp: data.otp,
									});
								},
							},
						}),
			}),
			jwt(buildJwtPluginOptions(options.jwt)),
			bearer(),
			/**
			 * SSO, registered only when there is at least one enabled provider.
			 *
			 * `genericOAuth` adds the initiate and callback routes that turn the stored provider rows
			 * into a working sign-in; with no providers the plugin is omitted so the routes do not exist
			 * rather than existing and answering "no such provider".
			 */
			...(options.ssoProviders && options.ssoProviders.length > 0
				? [genericOAuth({ config: buildGenericOAuthConfig(options.ssoProviders) })]
				: []),
			...((options.openApiEnabled ?? true) ? [openAPI()] : []),
		],
	});
}

export type Auth = ReturnType<typeof createAuth>;
export type AuthApi = Auth["api"];
