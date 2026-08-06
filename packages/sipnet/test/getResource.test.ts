import * as grpc from "@grpc/grpc-js";
import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { createScopedMetadata } from "@optimiq-voice/sipnet/test/testCall";
import { TEST_TOKEN } from "@optimiq-voice/sipnet/test/testToken";
import { BaseApiObject, Domain, DomainsApi } from "@optimiq-voice/types";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@sipnet[resources/getResource]", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should get a sipnet resource", async function () {
		// Arrange
		const { getResource } = await import("../src/resources/getResource");
		// Scoped by the tenancy interceptor (identity-removal Step 3 item 2), not by the caller.
		const metadata = createScopedMetadata();

		const domain = {
			ref: "123",
			name: "SIP Local",
			domainUri: "sip.optimiq-voice.local",
			extended: {
				accessKeyId: "GRahn02s8tgdfghz72vb0fz538qpb5z35p",
			},
			createdAt: new Date(),
			updatedAt: new Date(),
		};

		const domains = {
			getDomain: sandbox.stub().resolves(domain),
		} as unknown as DomainsApi;

		const call = {
			metadata,
			request: {
				ref: "123",
			},
		};

		const get = getResource<Domain, BaseApiObject, DomainsApi>(domains, "Domain");

		// Act
		await get(call, (error, response) => {
			// Assert
			expect(error).to.be.null;
			expect(response).to.deep.equal(domain);
		});
	});

	it("should throw an error if sipnet resource not found", async function () {
		// Arrange
		const { getResource } = await import("../src/resources/getResource");
		// Scoped by the tenancy interceptor (identity-removal Step 3 item 2), not by the caller.
		const metadata = createScopedMetadata();

		const domains = {
			getDomain: sandbox.stub().throws({
				code: grpc.status.NOT_FOUND,
				message: "The requested resource was not found",
			}),
		} as unknown as DomainsApi;

		const call = {
			metadata,
			request: {
				ref: "123",
			},
		};

		const callback = sandbox.stub();
		const get = getResource<Domain, BaseApiObject, DomainsApi>(domains, "Domain");

		// Act
		await get(call, callback);

		// Assert
		//
		// The message is `withTenantResourceAccess`'s own, not `handleError`'s: identity-removal
		// Step 3 item 4 moved the ownership check ahead of the handler, and a read that fails is
		// not an authorisation however it failed — so the wrapper answers before the SDK's error
		// reaches `handleError`. See the cross-tenant case below for why it answers this way.
		expect(callback).to.have.been.calledOnce;
		expect(callback).to.have.been.calledWithMatch({
			code: grpc.status.NOT_FOUND,
			message: "Domain not found: 123",
		});
	});

	it("should refuse a resource owned by another tenant, indistinguishably from an absent one", async function () {
		// Arrange
		const { getResource } = await import("../src/resources/getResource");
		const metadata = createScopedMetadata();

		// The row exists and is perfectly readable — it just belongs to somebody else.
		const foreignDomain = {
			ref: "123",
			name: "Someone Else's Domain",
			domainUri: "other.optimiq-voice.local",
			extended: {
				accessKeyId: "WO11111111111111111111111111111111",
			},
			createdAt: new Date(),
			updatedAt: new Date(),
		};

		const domains = {
			getDomain: sandbox.stub().resolves(foreignDomain),
		} as unknown as DomainsApi;

		const call = {
			metadata,
			request: {
				ref: "123",
			},
		};

		const callback = sandbox.stub();
		const get = getResource<Domain, BaseApiObject, DomainsApi>(domains, "Domain");

		// Act
		await get(call, callback);

		// Assert
		//
		// `NOT_FOUND` with the *same* message the absent-row case produces, deliberately:
		// `PERMISSION_DENIED` here would confirm the ref exists and turn this endpoint into an
		// enumeration oracle. It also matches what `apps/api`'s own resources now do, where RLS
		// makes another tenant's row genuinely absent (Step 5, item 4).
		expect(callback).to.have.been.calledOnce;
		expect(callback).to.have.been.calledWithMatch({
			code: grpc.status.NOT_FOUND,
			message: "Domain not found: 123",
		});
		// And nothing of the foreign row leaked into the response.
		expect(callback.firstCall.args[1]).to.be.undefined;
	});

	it("should refuse a resource whose owner was never recorded", async function () {
		// Arrange
		const { getResource } = await import("../src/resources/getResource");
		const metadata = createScopedMetadata();

		// `hasAccessToResource` opened with `if (!extended) return true`, so this GRANTED access
		// (identity-removal §6, and the note in `withTenantResourceAccess`). It must now refuse.
		const unownedDomain = {
			ref: "123",
			name: "Orphan",
			domainUri: "orphan.optimiq-voice.local",
			createdAt: new Date(),
			updatedAt: new Date(),
		};

		const domains = {
			getDomain: sandbox.stub().resolves(unownedDomain),
		} as unknown as DomainsApi;

		const call = {
			metadata,
			request: { ref: "123" },
		};

		const callback = sandbox.stub();
		const get = getResource<Domain, BaseApiObject, DomainsApi>(domains, "Domain");

		// Act
		await get(call, callback);

		// Assert
		expect(callback).to.have.been.calledOnce;
		expect(callback).to.have.been.calledWithMatch({
			code: grpc.status.NOT_FOUND,
			message: "Domain not found: 123",
		});
	});

	it("should refuse an unscoped call rather than reading anything", async function () {
		// Arrange
		const { getResource } = await import("../src/resources/getResource");

		// No tenancy interceptor ran: only the caller's own token is on the wire. The deleted
		// `getAccessKeyIdFromCall` returned `undefined` here and the read went ahead unscoped.
		const metadata = new grpc.Metadata();
		metadata.set("token", TEST_TOKEN);

		const domains = {
			getDomain: sandbox.stub().resolves({ ref: "123" }),
		} as unknown as DomainsApi;

		const call = {
			metadata,
			request: { ref: "123" },
		};

		const callback = sandbox.stub();
		const get = getResource<Domain, BaseApiObject, DomainsApi>(domains, "Domain");

		// Act
		await get(call, callback);

		// Assert
		expect(callback).to.have.been.calledOnce;
		expect(callback.firstCall.args[0]).to.have.property("code", grpc.status.INTERNAL);
		expect(domains.getDomain).to.not.have.been.called;
	});
});
