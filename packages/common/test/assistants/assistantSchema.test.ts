import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { assistantSchema } from "../../src";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@api[common/assistants/assistantSchema]", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("checks the tools have an empty array by default", async function () {
		// Arrange
		const assistantConfig = {
			conversationSettings: {
				firstMessage: "Hello",
				systemPrompt: "systemPrompt",
				goodbyeMessage: "goodbyeMessage",
				systemErrorMessage: "systemErrorMessage",
				initialDtmf: "1234",
				transferOptions: {
					phoneNumber: "phoneNumber",
					message: "message",
				},
				idleOptions: {
					message: "message",
				},
			},
			languageModel: {
				provider: "openai",
				apiKey: "apiKey",
				model: "gpt-4o",
				temperature: 1,
				maxTokens: 1,
			},
		};
		// Act
		const result = assistantSchema.parse(assistantConfig);

		// Assert
		expect(result.languageModel.tools).to.be.an("array").that.is.empty;
		expect(result.languageModel.knowledgeBase).to.be.an("array").that.is.empty;
		expect(result.conversationSettings.vad.activationThreshold).to.be.equal(0.4);
		expect(result.conversationSettings.vad.deactivationThreshold).to.be.equal(0.25);
		expect(result.conversationSettings.vad.debounceFrames).to.be.equal(4);
		expect(result.conversationSettings.transferOptions.timeout).to.be.equal(30000);
		expect(result.conversationSettings.maxSpeechWaitTimeout).to.be.equal(0);
		expect(result.conversationSettings.idleOptions.timeout).to.be.equal(30000);
		expect(result.conversationSettings.idleOptions.maxTimeoutCount).to.be.equal(2);
	});
});
