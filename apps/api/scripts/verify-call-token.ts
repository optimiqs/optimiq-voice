/**
 * End-to-end proof for the per-call access token (identity-removal Step 4).
 *
 *   DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq \
 *     pnpm --filter @optimiq-voice/api verify:call-token
 *
 * It boots the auth slice alone against a real PostgreSQL, mints a per-call token through
 * `CallTokenService`, fetches the published JWKS over HTTP and verifies the token against it with
 * `jose`.
 *
 * Section 6 then runs the **real** verifier from `@optimiq-voice/voice` —
 * `createCallTokenVerifier`, the one `VoiceServer` hands to its gRPC interceptor — against the
 * live `/api/auth/jwks` endpoint. That closes Step 4's loop at the level this environment can
 * reach: the minter in `apps/api` and the verifier in `packages/voice` agree on a token, with no
 * identity service, no `.keys/*.pem` and no gRPC `getPublicKey` round trip anywhere in the path.
 * The plan's full gate (an inbound call reaching an autopilot application) additionally needs
 * Asterisk and Routr, which are not available here.
 *
 * Deliberately separate from `verify:auth`.
 */

import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_DATABASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq";

/**
 * The same secret `verify-auth-slice.ts` uses, on purpose. The jwt plugin encrypts the JWKS
 * private key with `AUTH_SECRET`, so two verification scripts pointed at the same database must
 * agree on it or the second one cannot decrypt the row the first one created.
 */
const TEST_SECRET = process.env.AUTH_SECRET ?? "verify-auth-slice-secret-0123456789abcdef";

const ORGANIZATION_ID = "019fd3c2-0203-76be-a6b3-b0f1914e39b6";
const APP_REF = "3861b08b-1602-45e4-b523-dc3036ba85e7";
const CALL_REF = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

const checks: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail = ""): void {
	checks.push({ name, ok, detail });
	console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function findFreePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (typeof address === "string" || address === null) {
				server.close();
				reject(new Error("could not allocate an ephemeral port"));
				return;
			}
			const { port } = address;
			server.close(() => resolve(port));
		});
	});
}

async function main(): Promise<void> {
	const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
	const port = await findFreePort();
	const baseUrl = `http://127.0.0.1:${port}`;

	// @optimiq-voice/config parses the environment at import time, so it has to be complete
	// before anything importing it is loaded. Every import below is therefore dynamic.
	process.env.NODE_ENV = "test";
	process.env.DATABASE_URL = databaseUrl;
	process.env.AUTH_SECRET = TEST_SECRET;
	process.env.AUTH_URL = baseUrl;
	process.env.API_APP_URL = baseUrl;

	await import("reflect-metadata");
	const { NestFactory } = await import("@nestjs/core");
	const { FastifyAdapter } = await import("@nestjs/platform-fastify");
	const { createApiRootModule, registerAuthTransport } = await import("../src/auth/auth-bootstrap");
	const { CALL_TOKEN_AUDIENCE, CALL_TOKEN_ROLE } = await import("../src/auth/call-token.claims");
	const { CallTokenService } = await import("../src/auth/call-token.service");
	const { createLocalJWKSet, decodeProtectedHeader, jwtVerify } = await import("jose");

	console.log(`\nbooting the auth slice on ${baseUrl}\n`);
	const app = await NestFactory.create(createApiRootModule([]), new FastifyAdapter(), {
		logger: ["error", "warn"],
	});
	app.enableShutdownHooks();
	await registerAuthTransport(app);
	await app.listen(port, "127.0.0.1");
	await delay(100);

	try {
		console.log("1. mint a per-call token");
		const callTokens = app.get(CallTokenService);
		const token = await callTokens.createCallAccessToken({
			organizationId: ORGANIZATION_ID,
			appRef: APP_REF,
			callRef: CALL_REF,
		});
		check("a token is minted", typeof token === "string" && token.split(".").length === 3);

		const header = decodeProtectedHeader(token);
		check("the token is asymmetrically signed", header.alg !== "HS256", `alg ${header.alg}`);
		check("the token names the signing key", typeof header.kid === "string", `kid ${header.kid}`);

		console.log("2. fetch the published JWKS");
		const jwksResponse = await fetch(`${baseUrl}/api/auth/jwks`);
		check("/api/auth/jwks is served", jwksResponse.status === 200, `status ${jwksResponse.status}`);
		const jwks = (await jwksResponse.json()) as { keys: Record<string, unknown>[] };
		check("the JWKS publishes at least one key", (jwks.keys?.length ?? 0) > 0);
		check(
			"the JWKS contains the key the token was signed with",
			jwks.keys.some((key) => key.kid === header.kid),
		);

		console.log("3. verify the token against the JWKS");
		const keySet = createLocalJWKSet({ keys: jwks.keys as never });
		const { payload } = await jwtVerify(token, keySet, { audience: CALL_TOKEN_AUDIENCE });
		check("the token verifies against the published JWKS", true);

		console.log("4. claims");
		check("sub is the application ref", payload.sub === APP_REF, String(payload.sub));
		check("appRef is carried explicitly", payload.appRef === APP_REF);
		check("callRef binds the token to one call", payload.callRef === CALL_REF);
		check(
			"organizationId is the tenant claim",
			payload.organizationId === ORGANIZATION_ID,
			String(payload.organizationId),
		);
		check(
			"accessKeyId aliases organizationId for the legacy interceptor",
			payload.accessKeyId === ORGANIZATION_ID,
		);
		check(
			"access[] keeps the legacy shape",
			JSON.stringify(payload.access) ===
				JSON.stringify([{ accessKeyId: ORGANIZATION_ID, role: CALL_TOKEN_ROLE }]),
			JSON.stringify(payload.access),
		);
		check("tokenUse is access", payload.tokenUse === "access");
		check("iss is the auth base URL", payload.iss === baseUrl, String(payload.iss));

		const lifetime = (payload.exp ?? 0) - (payload.iat ?? 0);
		check("iat is stamped, as the identity-era signer did", typeof payload.iat === "number");
		check("the token lives 30 seconds", lifetime === 30, `${lifetime}s`);

		console.log("5. a tampered token is rejected");
		const [head, body, signature] = token.split(".");
		const forged = `${head}.${Buffer.from(
			JSON.stringify({ ...payload, organizationId: "someone-else" }),
		).toString("base64url")}.${signature}`;
		void body;
		let rejected = false;
		try {
			await jwtVerify(forged, keySet, { audience: CALL_TOKEN_AUDIENCE });
		} catch {
			rejected = true;
		}
		check("a re-signed payload fails verification", rejected);

		// -----------------------------------------------------------------------------------------
		// 6. The real packages/voice verifier, over real HTTP (identity-removal Step 4, item 2)
		// -----------------------------------------------------------------------------------------
		console.log("6. verify through packages/voice's createCallTokenVerifier");
		const { createCallTokenVerifier, CallTokenVerificationError } =
			await import("@optimiq-voice/voice");

		const verifyCallToken = createCallTokenVerifier({ authUrl: baseUrl });
		const claims = await verifyCallToken(token);
		check("the voice verifier accepts a freshly minted token", true);
		check(
			"it reads the tenant from organizationId, not from a client header",
			claims.organizationId === ORGANIZATION_ID,
			claims.organizationId,
		);
		check("it reads the application ref", claims.appRef === APP_REF, claims.appRef);
		check("it reads the call binding", claims.callRef === CALL_REF, String(claims.callRef));

		async function rejects(name: string, run: () => Promise<unknown>): Promise<void> {
			let error: unknown;
			try {
				await run();
			} catch (caught) {
				error = caught;
			}
			check(name, error instanceof CallTokenVerificationError, error ? "rejected" : "ACCEPTED");
		}

		await rejects("it rejects a missing token", async () => await verifyCallToken(undefined));
		await rejects("it rejects a garbage token", async () => await verifyCallToken("not.a.jwt"));
		await rejects("it rejects a re-signed payload", async () => await verifyCallToken(forged));
		await rejects(
			"it rejects a token minted for another audience",
			async () =>
				await createCallTokenVerifier({ authUrl: baseUrl, audience: "optimiq-voice/other" })(token),
		);

		check(
			"the verifier refuses to be built without an AUTH_URL",
			(() => {
				try {
					createCallTokenVerifier({ authUrl: "  " });
					return false;
				} catch {
					return true;
				}
			})(),
		);
	} finally {
		console.log("\ncleaning up");
		await app.close();
	}

	const failed = checks.filter((entry) => !entry.ok);
	console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
	if (failed.length > 0) {
		console.error(`FAILED: ${failed.map((entry) => entry.name).join(", ")}`);
		process.exitCode = 1;
		return;
	}
	console.log("per-call token verification PASSED");
}

await main();
