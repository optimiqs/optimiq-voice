import { join } from "path";
import dotenv from "dotenv";

/**
 * The API process's own environment surface, and all that is left of it.
 *
 * This file used to be the legacy platform's configuration sheet: twenty-two asserted keys, the
 * identity issuer and its OAuth2 client, the InfluxDB connection, the Routr peer credentials, the
 * Twilio pair, the integrations file — and, at module scope, two `readFileSync` calls that read
 * `.keys/private.pem` and `.keys/public.pem`. That last part is why it mattered: importing ANY
 * module that transitively reached here forced an RSA keypair to exist on disk, so every test run
 * and every boot had to run `gen-keypair.sh` first, for a signing key only the deleted identity
 * service ever used.
 *
 * The legacy consumers are gone, so their configuration went with them. What remains is the two
 * values `main.ts` reads, and nothing else — every functional area loads and validates its own
 * environment at its own boundary (`src/mail/mail-env.ts`, `src/pbx/shared/pbx-env.ts`,
 * `src/cdr/shared/cdr-env.ts`, `src/auth/auth.config.ts`), which is where a missing variable can
 * be reported against the thing that needs it.
 *
 * Deliberately absent, and deliberately NOT re-added as a convenience:
 *
 * - `assertEnvsAreSet` from the deleted `@optimiq-voice/common`. The area-level env loaders assert
 *   what they need.
 * - the keypair reads. Nothing in this app signs RS256 any more; `src/auth/call-token.service.ts`
 *   mints call tokens through better-auth's JWKS.
 * - `DATABASE_URL`. It existed for one caller — the base database's tenant-RLS preflight in
 *   `main.ts` — and that preflight went with the five legacy tables it asserted. The auth slice
 *   reads the canonical `DATABASE_URL` through `@optimiq-voice/config`, which is where the
 *   `API_DATABASE_URL` alias is resolved.
 */
if (process.env.NODE_ENV === "development") {
	// `import.meta.dirname` is the ES-module replacement for `__dirname`; it resolves to
	// `apps/api/src` under tsx and `apps/api/dist` after a build — the repository root either way.
	dotenv.config({ path: join(import.meta.dirname, "..", "..", "..", ".env") });
}

const e = process.env;

/** The port the HTTP bridge listens on: `/api/auth/*` and `/api/v1/*`. */
export const HTTP_BRIDGE_PORT = e.API_HTTP_BRIDGE_PORT ? parseInt(e.API_HTTP_BRIDGE_PORT) : 9876;
