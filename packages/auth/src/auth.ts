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
	/**
	 * Where the rate-limit counters live. Defaults to `"database"` — the `rate_limit` table in the
	 * auth schema — so every replica shares one window; `"secondary-storage"` is correct instead
	 * once a host supplies better-auth a Redis/valkey `secondaryStorage`. `"memory"` is per
	 * process: it is only honest for a single-replica dev run.
	 * @default "database"
	 */
	readonly rateLimitStorage?: "database" | "memory" | "secondary-storage";
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

/**
 * Rate limiting, on a store every replica shares.
 *
 * The default is `"database"` rather than better-auth's in-memory map: with N replicas that map
 * gives an attacker N times the limit and every deploy resets the window. The two credential
 * paths get their own, much tighter rules — the global default is sized for an API surface, not
 * for guessing a password or a six-digit code.
 */
function buildRateLimitOptions(options: CreateAuthOptions) {
	return {
		enabled: options.rateLimitEnabled ?? true,
		storage: options.rateLimitStorage ?? ("database" as const),
		customRules: {
			"/sign-in/email": { window: 60, max: 10 },
			"/two-factor/verify-otp": { window: 60, max: 5 },
			"/two-factor/verify-totp": { window: 60, max: 5 },
			"/two-factor/verify-backup-code": { window: 60, max: 5 },
			"/forget-password": { window: 60, max: 5 },
		},
	};
}

/** One OIDC provider, as the auth boot hands it to `genericOAuth`. */
export interface SsoProviderConfig {
	/** The slug in the callback URL: `/api/auth/oauth2/callback/<providerId>`. */
	readonly providerId: string;
	/**
	 * The tenant that owns the provider row.
	 *
	 * `genericOAuth`'s config is platform-wide, so this is the only thing that ties an identity
	 * asserted by tenant A's IdP back to tenant A. The callback path must compare it against the
	 * organization the resolved session landed in — see {@link assertSsoProviderOrganization}.
	 */
	readonly organizationId: string;
	readonly clientId: string;
	readonly clientSecret: string;
	/** The issuer; the discovery document is derived from it when `discoveryUrl` is absent. */
	readonly issuer: string;
	readonly discoveryUrl?: string;
	/** Defaults to `openid email profile` when the provider row named none. */
	readonly scopes?: readonly string[];
	/**
	 * The mail domain this provider is authoritative for. REQUIRED: a provider registered without
	 * one may assert any address at all, and a tenant admin configures their own IdP.
	 */
	readonly emailDomain: string;
}

const DEFAULT_SSO_SCOPES = ["openid", "email", "profile"] as const;

/** Raised at boot for a provider row that cannot be registered safely. */
export class SsoProviderConfigError extends Error {
	readonly _tag = "SsoProviderConfigError" as const;
	readonly providerId: string;

	constructor(providerId: string, message: string) {
		super(`SSO provider "${providerId}" ${message}`);
		this.name = "SsoProviderConfigError";
		this.providerId = providerId;
	}
}

function normalizeEmailDomain(value: string): string {
	return value.trim().toLowerCase().replace(/^@/u, "");
}

/** True when `email` is inside `domain` — the domain itself, not a subdomain of it. */
export function emailMatchesDomain(email: string, domain: string): boolean {
	const at = email.lastIndexOf("@");
	if (at === -1) {
		return false;
	}
	return (
		email
			.slice(at + 1)
			.trim()
			.toLowerCase() === normalizeEmailDomain(domain)
	);
}

/**
 * The tenant a provider slug belongs to, or `undefined` when the slug is unknown.
 *
 * The sign-in and callback routes use this to assert the session they are about to issue is
 * scoped to the SAME organization that configured the IdP.
 */
export function resolveSsoProviderOrganizationId(
	providers: readonly SsoProviderConfig[] | undefined,
	providerId: string,
): string | undefined {
	return providers?.find((provider) => provider.providerId === providerId)?.organizationId;
}

/**
 * Throws unless `organizationId` is the tenant that owns `providerId`.
 *
 * `genericOAuth` links an identity by email, and `activeOrganizationId` is then resolved from the
 * matched user's OWN membership — so without this check tenant A's IdP can mint a session in
 * tenant B by asserting a B address. Account linking is disabled as the first layer; this is the
 * second, and the one that survives a future decision to re-enable it.
 */
export function assertSsoProviderOrganization(input: {
	readonly providers: readonly SsoProviderConfig[] | undefined;
	readonly providerId: string;
	readonly organizationId: string | null | undefined;
}): void {
	const owner = resolveSsoProviderOrganizationId(input.providers, input.providerId);
	if (!owner) {
		throw new SsoProviderConfigError(input.providerId, "is not a registered provider");
	}
	if (input.organizationId !== owner) {
		throw new SsoProviderConfigError(
			input.providerId,
			`is owned by another organization than the session it resolved (${String(input.organizationId)})`,
		);
	}
}

/** Map the stored provider set to `genericOAuth`'s config, filling the OIDC defaults. */
function buildGenericOAuthConfig(providers: readonly SsoProviderConfig[]) {
	return providers.map((provider) => {
		const domain = normalizeEmailDomain(provider.emailDomain ?? "");
		if (domain.length === 0) {
			throw new SsoProviderConfigError(
				provider.providerId,
				"has no email domain; a provider that may assert any address is a cross-tenant takeover",
			);
		}
		return {
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
			/**
			 * Runs on the IdP profile before better-auth looks up or creates a user, so a provider
			 * that asserts an address outside the domain it was registered for never reaches the
			 * lookup at all.
			 */
			mapProfileToUser: (profile: Record<string, unknown>) => {
				const email = typeof profile.email === "string" ? profile.email : "";
				if (!emailMatchesDomain(email, domain)) {
					throw new SsoProviderConfigError(
						provider.providerId,
						`asserted an email outside its registered domain "${domain}"`,
					);
				}
				return {};
			},
		};
	});
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

		/**
		 * A generic-OAuth identity may never attach itself to a pre-existing local user.
		 *
		 * Provider rows are self-service: any org admin holding the SSO write permission can point
		 * one at an IdP they control. With linking on, `email_verified: true` from that IdP is
		 * enough for better-auth to hand them the account that already owns the address — in any
		 * tenant. The email-domain check in `buildGenericOAuthConfig` and the organization
		 * assertion in `assertSsoProviderOrganization` are the other two layers.
		 */
		account: { accountLinking: { enabled: false } },

		rateLimit: buildRateLimitOptions(options),

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
