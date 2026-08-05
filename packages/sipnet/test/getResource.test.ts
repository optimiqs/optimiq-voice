import * as grpc from "@grpc/grpc-js";
import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
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
		const metadata = new grpc.Metadata();
		metadata.set("token", TEST_TOKEN);

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
		const metadata = new grpc.Metadata();
		metadata.set("token", TEST_TOKEN);

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
		expect(callback).to.have.been.calledOnce;
		expect(callback).to.have.been.calledWithMatch({
			code: grpc.status.NOT_FOUND,
			message: "The requested resource was not found",
		});
	});
});
