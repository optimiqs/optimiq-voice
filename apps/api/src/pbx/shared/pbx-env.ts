import { z } from "zod/v4";

/**
 * The PBX area's environment contract.
 *
 * Two notes on the imports and the scope of this file.
 *
 * `zod/v4` rather than `zod`: `apps/api` still pins `zod@3.25.76` for ~19 legacy files in
 * `src/voice` and `src/applications`, and 3.25 ships the whole Zod 4 implementation under the
 * `zod/v4` subpath. New code therefore gets the oikos-mandated Zod 4 API without a rewrite of code
 * this wave does not touch. When the pin moves to the catalog's `zod@4`, the subpath becomes the
 * bare specifier and nothing else changes.
 *
 * App-local rather than a slice of `@optimiq-voice/config`, for the reason `apps/engine` records:
 * that package owns the ROOT `.env` and its production invariants, not every service's variables.
 * This is the one place in the PBX area that may read `process.env` (oikos §6); everything else
 * injects the parsed {@link PbxEnv}.
 */

const postgresUrl = z
	.string()
	.min(1)
	.regex(/^postgres(?:ql)?:\/\//iu, "must be a postgres:// URL");

const natsUrl = z
	.string()
	.min(1)
	.regex(/^nats:\/\//iu, "must be a nats:// URL, e.g. nats://localhost:4222");

export const pbxEnvSchema = z.object({
	/**
	 * The telephony bounded context's database. Separate from `DATABASE_URL` (better-auth, the
	 * legacy telephony tables) because they are separate databases — plan §3.3.
	 */
	PBX_DATABASE_URL: postgresUrl,

	/**
	 * Optional by design. Absent means the routing-cache publish and the
	 * `rpc.routing.v1.resolve` responder are skipped with a boot warning, and every REST feature
	 * still works: a developer without a broker must still be able to run CRUD, and an API that
	 * refused to boot without NATS would make the control plane depend on the backbone for
	 * configuration changes that do not need it.
	 */
	NATS_URL: natsUrl.optional(),

	/** Whether to create the `routing-cache` KV bucket if the broker does not have it yet. */
	PBX_ENSURE_KV_BUCKETS: z
		.stringbool({ truthy: ["true", "1"], falsy: ["false", "0", ""] })
		.default(true),

	/** Pool ceiling for the PBX pool specifically; the base client applies the shared budget. */
	PBX_DATABASE_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(100).default(10),

	/**
	 * How an extension number becomes a dial string in the media server's vocabulary.
	 *
	 * MUST match `apps/engine`'s `ENGINE_EXTENSION_DIAL_TEMPLATE`, and shares its default. The
	 * `queue-membership` bucket holds a resolved dial string per agent, not an extension number,
	 * because the engine hands it to the media server verbatim rather than re-deriving an endpoint
	 * from a number it cannot verify (see `packages/events` `queueMembershipAgentSchema`). Two
	 * templates that disagree produce a queue whose agents' phones never ring while every direct
	 * call to the same extension works — which is why this is stated here rather than assumed.
	 *
	 * A template rather than a hard-coded `PJSIP/` for the reason the engine records: the same code
	 * has to work against a registrar-backed deployment (`PJSIP/1001`) and a dialplan-mediated one
	 * (`Local/1001@context`).
	 */
	PBX_EXTENSION_DIAL_TEMPLATE: z.string().min(1).default("PJSIP/{number}"),
});

export type PbxEnv = z.infer<typeof pbxEnvSchema>;

/** Whether the area is configured at all. `main.ts` skips the module entirely when it is not. */
export function isPbxSliceConfigured(): boolean {
	return (
		typeof process.env.PBX_DATABASE_URL === "string" && process.env.PBX_DATABASE_URL.length > 0
	);
}

/**
 * Parses the environment, throwing on a contract violation.
 *
 * Called from the module factory, which Nest builds during `NestFactory.create` — before any
 * request can arrive. A malformed `PBX_DATABASE_URL` must stop the process at boot, not surface as
 * a 500 on the first extension list.
 */
export function loadPbxEnv(source: NodeJS.ProcessEnv = process.env): PbxEnv {
	const parsed = pbxEnvSchema.safeParse(source);
	if (!parsed.success) {
		const detail = parsed.error.issues
			.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("; ");
		throw new Error(`Invalid PBX environment — ${detail}`);
	}
	return parsed.data;
}
