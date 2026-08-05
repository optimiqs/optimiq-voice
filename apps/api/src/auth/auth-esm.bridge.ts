import type { INestApplication, Type } from "@nestjs/common";

/**
 * The one CommonJS → ES-module hop in `apps/api`.
 *
 * `apps/api` compiles to CommonJS with the pre-`exports`-map resolver inherited from the
 * repository root tsconfig, so it cannot typecheck against `@optimiq-voice/{auth,db,config}`.
 * The auth slice is therefore compiled separately (`src/auth/tsconfig.json`) into
 * `dist/auth/*.mjs`, and this file states the contract of `dist/auth/auth-bootstrap.mjs`.
 *
 * The specifier is held in a `string`-typed constant on purpose: the target is excluded from
 * this program, so a literal would be an unresolvable-module error. TypeScript lowers the
 * dynamic import to `require()`, which Node ≥22.12 answers for synchronous ES-module graphs;
 * under `tsx` in development it stays a real dynamic import and resolves the `.mts` source.
 *
 * DELETE THIS FILE when apps/api adopts the oikos tsconfig — `main.ts` then imports
 * `./auth/auth-bootstrap` directly.
 */

export interface AuthBootstrapModule {
	/** False when `DATABASE_URL` / `AUTH_SECRET` / `AUTH_URL` are not all configured. */
	readonly isAuthSliceEnabled: () => boolean;
	readonly createApiRootModule: (baseModules: readonly Type<unknown>[]) => Type<unknown>;
	readonly registerAuthTransport: (app: INestApplication) => Promise<void>;
}

const AUTH_BOOTSTRAP_SPECIFIER: string = "./auth-bootstrap.mjs";

export async function loadAuthBootstrap(): Promise<AuthBootstrapModule> {
	const loaded: unknown = await import(AUTH_BOOTSTRAP_SPECIFIER);
	return loaded as AuthBootstrapModule;
}
