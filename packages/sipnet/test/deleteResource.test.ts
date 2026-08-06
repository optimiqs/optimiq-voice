import * as grpc from "@grpc/grpc-js";
import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { BaseApiObject, Domain, DomainsApi } from "@optimiq-voice/types";
import { getExtendedFieldsHelper } from "./getExtendedFieldsHelper";
import { createScopedMetadata } from "./testCall";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@sipnet[resources/deleteResource]", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should delete a sipnet resource", async function () {
		// Arrange
		const { deleteResource } = await import("../src/resources/deleteResource");
		// Scoped by the tenancy interceptor (identity-removal Step 3 item 2), not by the caller.
		const metadata = createScopedMetadata();

		const domains = {
			deleteDomain: sandbox.stub().resolves({ ref: "123" }),
			getDomain: getExtendedFieldsHelper(sandbox),
		} as unknown as DomainsApi;

		const call = {
			metadata,
			request: {
				ref: "123",
			},
		};

		const callback = sandbox.stub();
		const deleteD = deleteResource<Domain, BaseApiObject, DomainsApi>(domains, "Domain");

		// Act
		await deleteD(call, callback);

		// Assert
		expect(callback).to.have.been.calledOnce;
		expect(callback).to.have.been.calledWith(null, { ref: "123" });
	});
});
