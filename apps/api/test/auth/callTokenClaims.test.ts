import { expect } from "chai";
import {
	buildCallAccessTokenClaims,
	CALL_TOKEN_AUDIENCE,
	CALL_TOKEN_EXPIRES_IN,
	CALL_TOKEN_ROLE,
	CallAccessTokenScopeError,
} from "../../src/auth/call-token.claims";

/**
 * The claim contract of the per-call token (identity-removal Step 4).
 *
 * `buildCallAccessTokenClaims` is pure so this contract can be pinned without a database, a key
 * pair or a running server. `scripts/verify-call-token.ts` proves the other half — that a token
 * carrying these claims validates against `/api/auth/jwks`.
 */
describe("@auth/callAccessTokenClaims", function () {
	const request = {
		organizationId: "019fd3c2-0203-76be-a6b3-b0f1914e39b6",
		appRef: "3861b08b-1602-45e4-b523-dc3036ba85e7",
		callRef: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
	};

	it("keeps sub on the application ref, as the identity-era token did", function () {
		expect(buildCallAccessTokenClaims(request).sub).to.equal(request.appRef);
	});

	it("carries the tenant as organizationId and as the legacy accessKeyId alias", function () {
		const claims = buildCallAccessTokenClaims(request);
		expect(claims.organizationId).to.equal(request.organizationId);
		expect(claims.accessKeyId).to.equal(request.organizationId);
	});

	it("keeps the legacy access[] shape so the gRPC interceptor still resolves a role", function () {
		expect(buildCallAccessTokenClaims(request).access).to.deep.equal([
			{ accessKeyId: request.organizationId, role: CALL_TOKEN_ROLE },
		]);
	});

	it("binds the token to one application and one call", function () {
		const claims = buildCallAccessTokenClaims(request);
		expect(claims.appRef).to.equal(request.appRef);
		expect(claims.callRef).to.equal(request.callRef);
	});

	it("keeps tokenUse and the audience stable", function () {
		const claims = buildCallAccessTokenClaims(request);
		expect(claims.tokenUse).to.equal("access");
		expect(claims.aud).to.equal(CALL_TOKEN_AUDIENCE);
	});

	it("stays as short-lived as the identity-era signer", function () {
		expect(CALL_TOKEN_EXPIRES_IN).to.equal("30s");
	});

	it("trims the identifiers it is scoped by", function () {
		const claims = buildCallAccessTokenClaims({
			organizationId: `  ${request.organizationId}  `,
			appRef: `\t${request.appRef}`,
			callRef: `${request.callRef}\n`,
		});
		expect(claims.organizationId).to.equal(request.organizationId);
		expect(claims.appRef).to.equal(request.appRef);
		expect(claims.callRef).to.equal(request.callRef);
	});

	it("refuses to mint an unscoped token", function () {
		for (const missing of ["organizationId", "appRef", "callRef"] as const) {
			expect(() => buildCallAccessTokenClaims({ ...request, [missing]: "   " }))
				.to.throw(CallAccessTokenScopeError)
				.with.property("missing")
				.that.deep.equals([missing]);
		}
	});
});
