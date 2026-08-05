import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@api[common/notifications/createSendEmail]", function () {
  afterEach(function () {
    return sandbox.restore();
  });

  it("should create a new email sender", async function () {
    // Arrange
    const config = {
      host: "smtp.example.com",
      port: 465,
      secure: true,
      auth: {
        user: "user",
        pass: "password"
      }
    };

    const { createSendEmail } =
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("../../src/notifications/createSendEmail");

    // Act
    const result = createSendEmail(config);

    // Assert
    expect(result).to.be.a("function");
    expect(result).to.have.property("name", "sendEmail");
  });

  it("should send an email", async function () {
    // Arrange
    const config = {
      host: "smtp.example.com",
      port: 465,
      secure: true,
      auth: {
        user: "user",
        pass: "password"
      }
    };

    const { createSendEmail } =
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("../../src/notifications/createSendEmail");

    // Stub await transporter.sendMail
    const sendEmailStub = sandbox
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      .stub(require("nodemailer"), "createTransport")
      .returns({
        sendMail: async () => {
          return { messageId: "123" };
        }
      });

    const emailSender = createSendEmail(config);

    const params = {
      from: "Optimiq Voice <info@optimiq-voice.local>",
      to: "user@example.com",
      subject: "Welcome to Optimiq Voice",
      html: "<p>Welcome to Optimiq Voice</p>"
    };

    // Act
    await emailSender(params);

    // Assert
    expect(sendEmailStub).to.have.been.calledOnce;
  });
});
