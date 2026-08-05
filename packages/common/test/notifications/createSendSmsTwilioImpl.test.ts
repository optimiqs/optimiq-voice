import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";

chai.use(chaiAsPromised);

describe("@api[common/notifications/createSendSmsTwilioImpl]", function () {
	it("should return a no-op sender when config is undefined", async function () {
		// Arrange
		const { createSendSmsTwilioImpl } =
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			require("../../src/notifications/createSendSmsTwilioImpl");

		// Act
		const sendSms = createSendSmsTwilioImpl(undefined);

		// Assert — must not throw, must resolve
		await expect(sendSms({ to: "+10000000000", body: "test" })).to.eventually.be.undefined;
	});

	it("should return a sender function when config is provided", function () {
		// Arrange
		const { createSendSmsTwilioImpl } =
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			require("../../src/notifications/createSendSmsTwilioImpl");

		const config = {
			accountSid: "ACtest",
			authToken: "token",
			sender: "+10000000000",
		};

		// Act
		const sendSms = createSendSmsTwilioImpl(config);

		// Assert
		expect(sendSms).to.be.a("function");
		expect(sendSms).to.have.property("name", "sendSms");
	});
});
