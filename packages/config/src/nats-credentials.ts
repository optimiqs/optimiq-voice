/**
 * NATS client credentials and transport security, resolved from the environment.
 *
 * The broker requires authentication (`config/nats.conf`). Every service that opens a connection
 * — apps/api's raw clients and its Nest microservice, apps/engine's JetStream client and its two
 * `ClientsModule` clients, the operational scripts — needs a user and a password, and reads them
 * from the environment here.
 *
 * ## Two layers of name, and why
 *
 * `NATS_USER` / `NATS_PASS` are the UNPREFIXED pair, and they are still the fallback everywhere:
 * the backbone is a platform capability rather than any one app's feature, on the same terms as
 * `NATS_URL` / `DATABASE_URL`, and an operator script or a one-off harness has no service identity
 * to speak of.
 *
 * `NATS_<SERVICE>_USER` / `NATS_<SERVICE>_PASS` — `NATS_API_USER`, `NATS_ENGINE_PASS`, and their
 * Go equivalents `NATS_MEDIAD_*` / `NATS_SIPD_*` — are the PER-SERVICE pair. `config/nats.conf`
 * gives each of those four users a subject permission set scoped to what that service actually
 * publishes and subscribes to, so a compromised media plane cannot read `rpc.sip.v1.credential`
 * and a compromised SIP edge cannot forge CDR legs. Passing the service tag to
 * {@link natsCredentials} is what selects that identity.
 *
 * The per-service pair takes precedence when BOTH halves are set; otherwise the unprefixed pair is
 * used. That ordering is what keeps a deployment that has not yet split its credentials working
 * unchanged, and it is why `NATS_USER` remains the dev/admin identity in the checked-in `.env`:
 * the `nats` CLI, `pnpm` verify scripts and the integration harnesses all connect with it.
 *
 * A HALF-SET pair throws, per pair. `NATS_API_USER` without `NATS_API_PASS` is a typo, not a
 * request to silently fall back to the shared credential — falling back would hand the API the
 * admin identity and hide the mistake until an audit.
 *
 * ## Why the credentials are options and not part of the URL
 *
 * `nats://user:pass@host:4222` works in every client this platform uses, and it is what `routr`
 * has to use because it is a third-party image with only a URL to configure. It is NOT what the
 * first-party services do, because they log the URL: `sip-credentials.responder.ts` writes
 * `{ servers: env.NATS_URL }` at info level when it starts serving, the live hub and every PBX
 * publisher do the same. A URL that carries the password puts it in the log aggregator.
 *
 * ## Why this lives in `@optimiq-voice/config` and not `@optimiq-voice/events`
 *
 * `@optimiq-voice/events` is the backbone CONTRACT — subjects, schemas, stream definitions — and
 * states that it contains no client code. This is client code. It is also, more precisely, an
 * environment reading, which is this package's job.
 *
 * It is exported from `./nats-credentials` as well as the package root so a caller can take the
 * helper WITHOUT importing `./env`, whose module side effects parse and validate the whole
 * environment at import time.
 */

/**
 * The shape this reads: any parsed env object that declares the two names.
 *
 * The `Record` arm of {@link NatsCredentialSource} is what admits `process.env`. It is needed
 * because every property here is optional, which makes this a WEAK TYPE — TypeScript then requires
 * an assigned value to share at least one declared property, and `NodeJS.ProcessEnv` declares none
 * of them, only an index signature.
 */
export interface NatsCredentialEnv {
	readonly NATS_USER?: string | undefined;
	readonly NATS_PASS?: string | undefined;
	readonly NATS_API_USER?: string | undefined;
	readonly NATS_API_PASS?: string | undefined;
	readonly NATS_ENGINE_USER?: string | undefined;
	readonly NATS_ENGINE_PASS?: string | undefined;
	readonly NATS_MEDIAD_USER?: string | undefined;
	readonly NATS_MEDIAD_PASS?: string | undefined;
	readonly NATS_SIPD_USER?: string | undefined;
	readonly NATS_SIPD_PASS?: string | undefined;
	readonly NATS_TLS_CA?: string | undefined;
	readonly NATS_TLS_ENABLED?: string | undefined;
}

/**
 * The services `config/nats.conf` defines a dedicated user for.
 *
 * `mediad` and `sipd` are Go and never call this function; they are named here anyway so the one
 * list of service identities lives in one place and a rename cannot drift between the two
 * languages silently.
 */
export type NatsServiceName = "api" | "engine" | "mediad" | "sipd";

/** Either a typed env object or a raw string map such as `process.env`. */
export type NatsCredentialSource = NatsCredentialEnv | Readonly<Record<string, string | undefined>>;

/**
 * Spreads into a `nats` `ConnectionOptions` and into a Nest `Transport.NATS` options object
 * unchanged — both name the fields `user` and `pass`. Structural on purpose: this package does not
 * depend on the `nats` client and should not start.
 */
export interface NatsClientCredentials {
	readonly user?: string;
	readonly pass?: string;
}

/**
 * One of the pair is set and the other is not.
 *
 * Thrown rather than shrugged off because the alternative is silent: a connection built from half
 * a credential is rejected by the broker with `Authorization Violation` at the first connect, and
 * most of the services that connect here catch that and log a warning — so the process comes up
 * "healthy" with a dead backbone. A typo in one variable name should stop the boot, not degrade it.
 */
export class NatsCredentialsIncompleteError extends Error {
	readonly _tag = "NatsCredentialsIncompleteError" as const;

	constructor(
		readonly present: string,
		missing: string = present === "NATS_USER" ? "NATS_PASS" : "NATS_USER",
	) {
		super(
			`${present} is set but ${missing} is not. NATS authentication needs both: a connection ` +
				`built from half a credential is refused by the broker and the refusal is usually ` +
				`logged rather than fatal, so the process would come up with a dead backbone.`,
		);
		this.name = "NatsCredentialsIncompleteError";
	}
}

/** Reads one `<USER>` / `<PASS>` pair, enforcing that it is whole or absent. */
function readPair(
	source: NatsCredentialSource,
	userName: string,
	passName: string,
): NatsClientCredentials | undefined {
	const record = source as Readonly<Record<string, string | undefined>>;
	const user = record[userName]?.trim();
	const pass = record[passName]?.trim();

	if (user && pass) {
		return { user, pass };
	}
	if (user) {
		throw new NatsCredentialsIncompleteError(userName, passName);
	}
	if (pass) {
		throw new NatsCredentialsIncompleteError(passName, userName);
	}
	return undefined;
}

/**
 * Resolves the connection credentials, preferring the caller's own service identity.
 *
 * With a `service` tag, `NATS_<SERVICE>_USER` / `NATS_<SERVICE>_PASS` win when both are present —
 * that is the least-privilege user `config/nats.conf` defines for it. Without one, or with the
 * pair absent, the shared `NATS_USER` / `NATS_PASS` are used, which is what every operational
 * script and every deployment that has not split its credentials still connects with.
 *
 * Neither set returns `{}` — an UNAUTHENTICATED broker, which is what the integration harnesses
 * and the verify scripts start for themselves on an ephemeral port, and what a deployment that has
 * not yet applied `config/nats.conf` still runs. Production is not left to this function's
 * judgement: `assertEnvInvariants` refuses to boot a production process whose `NATS_URL` is set
 * without both credentials.
 */
export function natsCredentials(
	source: NatsCredentialSource,
	service?: NatsServiceName,
): NatsClientCredentials {
	if (service !== undefined) {
		const tag = service.toUpperCase();
		const scoped = readPair(source, `NATS_${tag}_USER`, `NATS_${tag}_PASS`);
		if (scoped !== undefined) {
			return scoped;
		}
	}

	return readPair(source, "NATS_USER", "NATS_PASS") ?? {};
}

/**
 * The TLS half of a `nats` `ConnectionOptions`, spread alongside {@link natsCredentials}.
 *
 * `undefined`/absent `tls` is a PLAINTEXT connection in the Node client; `tls: {}` turns
 * verification on against the system trust store; `tls: { caFile }` verifies against a private CA,
 * which is what the development certificates from `config/certs/generate-dev-certs.sh` need.
 */
export interface NatsTlsOptions {
	readonly tls?: { readonly caFile?: string };
}

/**
 * Resolves transport security, and defaults to OFF.
 *
 * Two names, because there are two genuinely different situations:
 *
 *   `NATS_TLS_CA`       a path to a CA bundle. Setting it enables TLS AND pins that CA. This is
 *                       the development path and the private-CA production path.
 *   `NATS_TLS_ENABLED`  `true` with no CA: TLS against the system trust store, for a broker whose
 *                       certificate comes from a public issuer.
 *
 * Neither set means a bare `nats://` connection, unchanged. That default is deliberate and it is
 * what keeps `pnpm start:services` working on a checkout that has never run the certificate
 * script: the broker's own `tls` block lives in `compose.tls.yaml`, an overlay, so the shipped
 * stack and the client default agree on plaintext rather than half-agreeing and failing to
 * connect.
 *
 * The URL SCHEME is not consulted. `nats://` and `tls://` both work in the Node client once `tls`
 * is present, and requiring the two to agree would make a deployment that flipped one and not the
 * other fail at connect time for a reason that reads as a certificate problem.
 */
export function natsTlsOptions(source: NatsCredentialSource): NatsTlsOptions {
	const record = source as Readonly<Record<string, string | undefined>>;
	const caFile = record.NATS_TLS_CA?.trim();

	if (caFile) {
		return { tls: { caFile } };
	}

	const enabled = record.NATS_TLS_ENABLED?.trim().toLowerCase();
	if (enabled === "true" || enabled === "1") {
		return { tls: {} };
	}

	return {};
}

/**
 * Everything a first-party client needs on top of `servers`: identity and transport security.
 *
 * The two are separate functions because they are separately useful — a harness against an
 * unauthenticated broker wants neither, `assertEnvInvariants` reasons about credentials alone —
 * and one combined helper for the common call site, because a connection that took the credentials
 * and forgot the CA fails with a TLS error that says nothing about the omission.
 */
export function natsConnectionOptions(
	source: NatsCredentialSource,
	service?: NatsServiceName,
): NatsClientCredentials & NatsTlsOptions {
	return { ...natsCredentials(source, service), ...natsTlsOptions(source) };
}
