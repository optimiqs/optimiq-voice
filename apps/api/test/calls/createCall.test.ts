/* eslint-disable prettier/prettier */
import { Metadata } from "@grpc/grpc-js";
import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { Database } from "../../src/core/db";
import { TEST_TOKEN, TEST_UUID } from "../utils";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@calls/createCall", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should create a call", async function () {
		// Arrange
		const { createCall } = await import("../../src/calls/createCall");
		const metadata = new Metadata();
		metadata.set("token", TEST_TOKEN);
		const publisher = {
			publishCall: sandbox.stub(),
		};
		const call = {
			metadata,
			request: {
				from: "+1234567890",
				to: "+1234567891",
				appRef: TEST_UUID,
			},
		};

		const application = {
			ref: TEST_UUID,
			name: "My Application",
			endpoint: "example.com:50051",
			accessKeyId: "GRahn02s8tgdfghz72vb0fz538qpb5z35p",
			createdAt: new Date(),
			updatedAt: new Date(),
		};

		const applications = {
			application: {
				findUnique: sandbox.stub().resolves(application),
			},
		} as unknown as Database;

		// Act
		await createCall(applications, publisher)(call, sandbox.stub());

		// Assert
		expect(publisher.publishCall).to.have.been.calledOnce;
		expect(applications.application.findUnique).to.have.been.calledOnce;
		expect(publisher.publishCall).to.have.been.calledWithMatch({
			from: "+1234567890",
			to: "+1234567891",
			appRef: TEST_UUID,
		});
	});
});
