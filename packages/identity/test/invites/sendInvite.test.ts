import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@identity[invites/sendInvite]", function () {
  afterEach(function () {
    return sandbox.restore();
  });

  it("should send an email", async function () {
    // Arrange
    const sendEmail = sandbox.stub();
    const request = {
      sender: "Optimiq Voice <info@optimiq-voice.local>",
      recipient: "user@example.com",
      inviteUrl: "http://example.com?token=jwt",
      oneTimePassword: "123456",
      workspaceName: "My Workspace",
      isExistingUser: false
    };

    const { sendInvite } =
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("../../src/invites/sendInvite");

    // Act
    await sendInvite(sendEmail, request);

    // Assert
    expect(sendEmail).to.have.been.calledOnce;
  });
});
