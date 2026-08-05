import { Metadata } from "@grpc/grpc-js";

const TEST_TOKEN =
	"eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL2Zvbm9zdGVyLmxvY2FsIiwic3ViIjoiNjM1YzBjZDgtODEyNS00ODNkLWI0NjctMDVjNTNjZTJjZDMxIiwiYXVkIjoiYXBpIiwidG9rZW5Vc2UiOiJhY2Nlc3MiLCJhY2Nlc3NLZXlJZCI6IlVTMTR3ajhxNnFsaXJ3MzMxZ2Zzd3VzZmJsaWU2aDc4dXoiLCJhY2Nlc3MiOlt7ImFjY2Vzc0tleUlkIjoiR1JhaG4wMnM4dGdkZmdoejcydmIwZno1MzhxcGI1ejM1cCIsInJvbGUiOiJPV05FUiJ9LHsiYWNjZXNzS2V5SWQiOiJHUmtnYmY4YW1pbnl3dWV2dXBiZHB4bDYzNmtjM2N5YmhvIiwicm9sZSI6Ik9XTkVSIn1dLCJpYXQiOjE3MTQ0MzM3MzZ9.eG6UEe8nBncu1I8TtytG5bModK42JxuSLCK74eLzUb-7MLowza8ZSfoHPHSPu5j1Wy_nj8NWa1u1SvqTfW-8inoL8Y_Mawl_u9zSM09Co85RQOI_bj7huGB7v0UECLfKyd7cAo_9wGB9TDDDX5Qo66bQz49hu_8zed8e6RzJXYRC5-5TBlyYdw3o7yHUXL5t8tFxDhT7U61kg0eVjPPZCAUiyohK74Zxdv1Z9RCfWTt9kUYXReqOUvhAFzL5Um5KwNdRnWwFRz_3-Msui2axAsZ6ztGoAvw_GhdlAminGEq7FILVCh6OHeOESAYo-qreAANmbwfBS8qNsglTiPAUEw";

const TEST_UUID = "13225251-c790-482d-912f-1646d054dc8c";

/**
 * The tenant a test call is scoped to.
 *
 * Since the tenancy rewrite the organization is **server-stamped** metadata: an interceptor
 * derives it from the verified token and `metadata.set`s it before the handler runs, so a call
 * fixture that omits it is not "an unscoped call", it is a call that never reached the server.
 * Every handler-level fixture therefore builds its metadata with {@link createTestCallMetadata}.
 */
const TEST_ORGANIZATION_ID = "019fd419-3579-73b9-95a0-b26037fa0cc3";

/**
 * The legacy `WO…` workspace key the same interceptor stamps for a tenant that has one. Only the
 * Routr-facing paths (`createCreateTestToken`) and the pre-cutover half of the CDR filter still
 * read it; nothing in the database does.
 */
const TEST_ACCESS_KEY_ID = "WO14wj8q6qlirw331gfswusfblie6h78uz";

/** Metadata as the tenancy interceptor leaves it: token in, tenant stamped. */
function createTestCallMetadata(): Metadata {
	const metadata = new Metadata();
	metadata.set("token", TEST_TOKEN);
	metadata.set("organizationid", TEST_ORGANIZATION_ID);
	metadata.set("accesskeyid", TEST_ACCESS_KEY_ID);
	return metadata;
}

export { createTestCallMetadata, TEST_ACCESS_KEY_ID, TEST_ORGANIZATION_ID, TEST_TOKEN, TEST_UUID };
