/**
 * NATS client credentials, resolved from the environment.
 *
 * The broker requires authentication (`config/nats.conf`). Every service that opens a connection
 * — apps/api's raw clients and its Nest microservice, apps/engine's JetStream client and its two
 * `ClientsModule` clients, the operational scripts — needs the same two values, so they are read
 * under the same two names everywhere: `NATS_USER` and `NATS_PASS`. Unprefixed, because the
 * backbone is a platform capability rather than any one app's feature, on the same terms as
 * `NATS_URL` / `DATABASE_URL`.
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
}

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

	constructor(readonly present: "NATS_USER" | "NATS_PASS") {
		const missing = present === "NATS_USER" ? "NATS_PASS" : "NATS_USER";
		super(
			`${present} is set but ${missing} is not. NATS authentication needs both: a connection ` +
				`built from half a credential is refused by the broker and the refusal is usually ` +
				`logged rather than fatal, so the process would come up with a dead backbone.`,
		);
		this.name = "NatsCredentialsIncompleteError";
	}
}

/**
 * Resolves the connection credentials.
 *
 * Neither set returns `{}` — an UNAUTHENTICATED broker, which is what the integration harnesses
 * and the verify scripts start for themselves on an ephemeral port, and what a deployment that has
 * not yet applied `config/nats.conf` still runs. Production is not left to this function's
 * judgement: `assertEnvInvariants` refuses to boot a production process whose `NATS_URL` is set
 * without both credentials.
 */
export function natsCredentials(source: NatsCredentialSource): NatsClientCredentials {
	const user = source.NATS_USER?.trim();
	const pass = source.NATS_PASS?.trim();

	if (user && pass) {
		return { user, pass };
	}
	if (user) {
		throw new NatsCredentialsIncompleteError("NATS_USER");
	}
	if (pass) {
		throw new NatsCredentialsIncompleteError("NATS_PASS");
	}
	return {};
}
