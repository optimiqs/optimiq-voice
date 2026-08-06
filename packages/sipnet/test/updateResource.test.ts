import * as grpc from "@grpc/grpc-js";
import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { Validators as V } from "@optimiq-voice/common";
import { getExtendedFieldsHelper } from "@optimiq-voice/sipnet/test/getExtendedFieldsHelper";
import { createScopedMetadata } from "@optimiq-voice/sipnet/test/testCall";
import { Domain, DomainsApi, UpdateDomainRequest } from "@optimiq-voice/types";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@sipnet[resources/updateResource]", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should update a sipnet resource", async function () {
		// Arrange
		const { updateResource } = await import("../src/resources/updateResource");
		// Scoped by the tenancy interceptor (identity-removal Step 3 item 2), not by the caller.
		const metadata = createScopedMetadata();

		const domains = {
			updateDomain: sandbox.stub().resolves({ ref: "123" }),
			getDomain: getExtendedFieldsHelper(sandbox),
		} as unknown as DomainsApi;

		const call = {
			metadata,
			request: {
				ref: "123",
				name: "My Domain",
				accessControlListRef: "123",
				egressPolicies: [],
			},
		};

		const callback = sandbox.stub();

		const update = updateResource<Domain, UpdateDomainRequest, DomainsApi>(
			domains,
			"Domain",
			V.updateDomainRequestSchema,
		);

		// Act
		await update(call, callback);

		// Assert
		expect(callback).to.have.been.calledOnceWithExactly(null, { ref: "123" });
	});

	it("should throw an error if the sipnet resource doesn't exists", async function () {
		// Arrange
		const { updateResource } = await import("../src/resources/updateResource");
		// Scoped by the tenancy interceptor (identity-removal Step 3 item 2), not by the caller.
		const metadata = createScopedMetadata();

		const domains = {
			updateDomain: sandbox.stub().throws({
				code: grpc.status.NOT_FOUND,
				message: "The requested resource was not found",
			}),
			getDomain: getExtendedFieldsHelper(sandbox),
		} as unknown as DomainsApi;

		const call = {
			metadata,
			request: {
				ref: "123",
				name: "My Domain",
				accessControlListRef: "123",
				egressPolicies: [],
			},
		};

		const callback = sandbox.stub();

		const update = updateResource<Domain, UpdateDomainRequest, DomainsApi>(
			domains,
			"Domain",
			V.updateDomainRequestSchema,
		);

		// Act
		await update(call, callback);

		// Assert
		expect(callback).to.have.been.calledOnceWithExactly({
			code: grpc.status.NOT_FOUND,
			message: "The requested resource was not found",
		});
	});
});
