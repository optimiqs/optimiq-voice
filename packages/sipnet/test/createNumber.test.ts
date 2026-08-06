import * as grpc from "@grpc/grpc-js";
import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { APP_REF_HEADER, ROUTR_DEFAULT_PEER_AOR } from "@optimiq-voice/common";
import { NumbersApi } from "@optimiq-voice/types";
import { createScopedMetadata, TEST_ACCESS_KEY_ID } from "./testCall";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

const TELEPHONE_NUMBER = "+1234567890";

describe("@sipnet[sipnet/createNumber]", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should create a number resource", async function () {
		// Arrange
		const { createNumber } = await import("../src/numbers/createNumber");
		const accessKeyId = TEST_ACCESS_KEY_ID;
		// Scoped by the tenancy interceptor (identity-removal Step 3 item 2), not by the caller.
		const metadata = createScopedMetadata({ accessKeyId });

		const numbers = {
			createNumber: sandbox.stub().resolves({ ref: "123" }),
		} as unknown as NumbersApi;

		const call = {
			metadata,
			request: {
				name: "My Number",
				telUrl: TELEPHONE_NUMBER,
				city: "New York",
				country: "USA",
				countryIsoCode: "US",
				appRef: "123",
				trunkRef: "456",
			},
		};

		const callback = sandbox.stub();
		const checkNumberPreconditions = sandbox.stub();

		const create = createNumber(numbers, checkNumberPreconditions);

		// Act
		await create(call, callback);

		// Assert
		expect(callback).to.have.been.calledOnceWithExactly(null, { ref: "123" });
		expect(numbers.createNumber).to.have.been.calledOnceWith({
			name: call.request.name,
			telUrl: call.request.telUrl,
			city: call.request.city,
			aorLink: ROUTR_DEFAULT_PEER_AOR,
			country: call.request.country,
			countryIsoCode: call.request.countryIsoCode,
			extraHeaders: [{ name: APP_REF_HEADER, value: call.request.appRef }],
			extended: { accessKeyId },
			trunkRef: call.request.trunkRef,
		});
	});

	it("should throw a validation error if the country ISO code is invalid", async function () {
		// Arrange
		const { createNumber } = await import("../src/numbers/createNumber");
		const metadata = createScopedMetadata();

		const numbers = {
			createNumber: sandbox.stub().resolves({ ref: "123" }),
		} as unknown as NumbersApi;

		const call = {
			metadata,
			request: {
				name: "My Number",
				telUrl: TELEPHONE_NUMBER,
				city: "New York",
				country: "USA",
				countryIsoCode: "USA",
				appRef: "123",
			},
		};

		const callback = sandbox.stub();
		const checkNumberPreconditions = sandbox.stub();

		const create = createNumber(numbers, checkNumberPreconditions);

		// Act
		await create(call, callback);

		// Assert
		expect(callback).to.have.been.calledOnceWithExactly({
			code: grpc.status.INVALID_ARGUMENT,
			message: "Invalid country ISO code",
		});
		expect(numbers.createNumber).to.not.have.been.called;
	});

	it("should throw a validation error if the SIP URI is invalid", async function () {
		// Arrange
		const { createNumber } = await import("../src/numbers/createNumber");
		const metadata = createScopedMetadata();

		const numbers = {
			createNumber: sandbox.stub().resolves({ ref: "123" }),
		} as unknown as NumbersApi;

		const call = {
			metadata,
			request: {
				name: "My Number",
				telUrl: TELEPHONE_NUMBER,
				city: "New York",
				country: "USA",
				countryIsoCode: "US",
				agentAor: "sip:123",
			},
		};

		const callback = sandbox.stub();
		const checkNumberPreconditions = sandbox.stub();

		const create = createNumber(numbers, checkNumberPreconditions);

		// Act
		await create(call, callback);

		// Assert
		expect(callback).to.have.been.calledOnceWithExactly({
			code: grpc.status.INVALID_ARGUMENT,
			// eslint-disable-next-line prettier/prettier
			message: 'Invalid SIP URI at "agentAor"',
		});
	});

	it("should throw a precondition error if the appRef does not exist", async function () {
		// Arrange
		const { createNumber } = await import("../src/numbers/createNumber");
		const metadata = createScopedMetadata();

		const numbers = {
			createNumber: sandbox.stub().resolves({ ref: "123" }),
		} as unknown as NumbersApi;

		const call = {
			metadata,
			request: {
				name: "My Number",
				telUrl: TELEPHONE_NUMBER,
				city: "New York",
				country: "USA",
				countryIsoCode: "US",
				appRef: "123",
			},
		};

		const callback = sandbox.stub();

		const checkNumberPreconditions = sandbox.stub().throws({
			code: grpc.status.INVALID_ARGUMENT,
			message: "The application does not exist",
		});

		const create = createNumber(numbers, checkNumberPreconditions);

		// Act
		await create(call, callback);

		// Assert
		expect(callback).to.have.been.calledOnceWithExactly({
			code: grpc.status.INVALID_ARGUMENT,
			message: "The application does not exist",
		});
		expect(numbers.createNumber).to.not.have.been.called;
	});
});
