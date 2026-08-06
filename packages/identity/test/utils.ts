import { generateKeyPairSync } from "node:crypto";
import { Metadata } from "@grpc/grpc-js";
import { stampOrganizationIdOnCall, stampTenantAccessKeyOnCall } from "@optimiq-voice/common";

const TEST_TOKEN =
	"eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL2Zvbm9zdGVyLmxvY2FsIiwic3ViIjoiNjM1YzBjZDgtODEyNS00ODNkLWI0NjctMDVjNTNjZTJjZDMxIiwiYXVkIjoiYXBpIiwidG9rZW5Vc2UiOiJhY2Nlc3MiLCJhY2Nlc3NLZXlJZCI6IlVTMTR3ajhxNnFsaXJ3MzMxZ2Zzd3VzZmJsaWU2aDc4dXoiLCJhY2Nlc3MiOlt7ImFjY2Vzc0tleUlkIjoiR1JhaG4wMnM4dGdkZmdoejcydmIwZno1MzhxcGI1ejM1cCIsInJvbGUiOiJPV05FUiJ9LHsiYWNjZXNzS2V5SWQiOiJHUmtnYmY4YW1pbnl3dWV2dXBiZHB4bDYzNmtjM2N5YmhvIiwicm9sZSI6Ik9XTkVSIn1dLCJpYXQiOjE3MTQ0MzM3MzZ9.eG6UEe8nBncu1I8TtytG5bModK42JxuSLCK74eLzUb-7MLowza8ZSfoHPHSPu5j1Wy_nj8NWa1u1SvqTfW-8inoL8Y_Mawl_u9zSM09Co85RQOI_bj7huGB7v0UECLfKyd7cAo_9wGB9TDDDX5Qo66bQz49hu_8zed8e6RzJXYRC5-5TBlyYdw3o7yHUXL5t8tFxDhT7U61kg0eVjPPZCAUiyohK74Zxdv1Z9RCfWTt9kUYXReqOUvhAFzL5Um5KwNdRnWwFRz_3-Msui2axAsZ6ztGoAvw_GhdlAminGEq7FILVCh6OHeOESAYo-qreAANmbwfBS8qNsglTiPAUEw";

const TEST_UUID = "635c0cd8-8125-483d-b467-05c53ce2cd31";

const { privateKey: TEST_PRIVATE_KEY } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { format: "pem", type: "pkcs8" },
	publicKeyEncoding: { format: "pem", type: "spki" },
});

/**
 * The tenant `TEST_TOKEN` grants — its first `access[]` entry, and the value every workspace
 * fixture in this suite carries in `accessKeyId`.
 */
const TEST_ACCESS_KEY_ID = "GRahn02s8tgdfghz72vb0fz538qpb5z35p";

/** A stand-in `organization.id` for the same tenant (identity-removal Step 2 maps one to the other). */
const TEST_ORGANIZATION_ID = "0198f0a4-7a1e-7c3f-9a52-6b0f2c8d4e11";

/**
 * The metadata a *scoped* call carries.
 *
 * Identity-removal Step 3 item 2 deleted `getAccessKeyIdFromCall` — the client-supplied
 * `accesskeyid` header these handlers used to read — and replaced it with
 * `getTenantAccessKeyFromCall`, which reads the **same key** but only after
 * `apps/api/src/core/createTenancyInterceptor.ts` has overwritten it with the tenant resolved
 * from the verified token. The old helper returned `undefined` for an unscoped call; the new one
 * throws `MissingTenantScopeError`, so a fixture that stamps only `token` now produces an
 * `INTERNAL` before the handler body runs.
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

export {
	createScopedMetadata,
	TEST_ACCESS_KEY_ID,
	TEST_ORGANIZATION_ID,
	TEST_PRIVATE_KEY,
	TEST_TOKEN,
	TEST_UUID,
};
