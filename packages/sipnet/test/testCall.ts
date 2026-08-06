import { Metadata } from "@grpc/grpc-js";
import { stampOrganizationIdOnCall, stampTenantAccessKeyOnCall } from "@optimiq-voice/common";
import { TEST_TOKEN } from "./testToken";

/**
 * The tenant `TEST_TOKEN` grants — its first `access[]` entry, and the owner recorded by
 * `getExtendedFieldsHelper` on every Routr row these fixtures stub.
 */
const TEST_ACCESS_KEY_ID = "GRahn02s8tgdfghz72vb0fz538qpb5z35p";

/**
 * A stand-in `organization.id` for the same tenant. Identity-removal Step 2 maps one to the other
 * (`legacy_workspace_organization`); the handlers only ever log or forward it, so its exact value
 * is immaterial — that it is *present* is the whole point.
 */
const TEST_ORGANIZATION_ID = "0198f0a4-7a1e-7c3f-9a52-6b0f2c8d4e11";

/**
 * The metadata a **scoped** call carries.
 *
 * Identity-removal Step 3 item 2 deleted `getAccessKeyIdFromCall`, the client-supplied
 * `accesskeyid` header these handlers used to read, and replaced it with two server-written
 * stamps that `apps/api/src/core/createTenancyInterceptor.ts` derives from the verified token:
 *
 * | stamp                        | read by                                                     |
 * | ---------------------------- | ----------------------------------------------------------- |
 * | `organizationid`             | `getOrganizationIdFromCall` — the canonical tenant          |
 * | `accesskeyid` (server-written) | `getTenantAccessKeyFromCall` — the key on Routr's JSONB    |
 *
 * Both **throw** `MissingTenantScopeError` when absent, where the deleted helper returned
 * `undefined`. That is deliberate (a tenant-scoped query built from `undefined` is how "list
 * everything" bugs happen) and it is why a fixture that stamps only `token` now yields `INTERNAL`
 * before the handler body runs.
 *
 * The stamps go through the real `stamp*` helpers rather than literal strings so the metadata key
 * names cannot drift between the interceptor and these fixtures.
 */
function createScopedMetadata(
	options: {
		token?: string;
		accessKeyId?: string;
		organizationId?: string;
	} = {},
): Metadata {
	const {
		token = TEST_TOKEN,
		accessKeyId = TEST_ACCESS_KEY_ID,
		organizationId = TEST_ORGANIZATION_ID,
	} = options;

	const metadata = new Metadata();
	metadata.set("token", token);
	stampTenantAccessKeyOnCall(metadata, accessKeyId);
	stampOrganizationIdOnCall(metadata, organizationId);

	return metadata;
}

export { createScopedMetadata, TEST_ACCESS_KEY_ID, TEST_ORGANIZATION_ID };
