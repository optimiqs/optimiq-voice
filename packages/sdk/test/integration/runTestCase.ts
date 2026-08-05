import { OptimiqVoiceClient } from "../../src/client/types";

type TestCase = {
	id: string;
	name: string;
	method: string;
	request: unknown;
	grpcCode?: number;
	dependsOn?: string;
	responseValidator?: (response: unknown) => void;
	skip?: boolean;
	only?: boolean;
	afterTestDelay?: number;
};

async function runTestCase(params: {
	client: OptimiqVoiceClient;
	api: string;
	testCase: TestCase;
	tooling: { expect; SDK };
}) {
	const { expect, SDK } = params.tooling;
	const { client, api, testCase } = params;

	const { method, request, grpcCode, responseValidator, afterTestDelay } = testCase;
	const apiInstance = new SDK[api](client);
	const clientMethod = apiInstance[method].bind(apiInstance);

	try {
		const response = await clientMethod(request);

		expect(response).to.not.be.undefined;

		if (responseValidator) {
			responseValidator(response);
		}

		if (grpcCode) expect.fail(`Expected error code ${grpcCode}`);

		if (afterTestDelay) {
			await new Promise((resolve) => setTimeout(resolve, afterTestDelay));
		}

		return response;
	} catch (error) {
		if (grpcCode) {
			expect(error.code).to.equal(grpcCode);
			return;
		}
		throw error;
	}
}

export { TestCase, runTestCase };
