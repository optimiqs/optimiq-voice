import * as grpc from "@grpc/grpc-js";
import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { DatabaseErrorCode } from "@optimiq-voice/common";
import { ApplicationType } from "@optimiq-voice/types";
import { TEST_TOKEN } from "../utils";
import type { Database } from "../../src/core/db";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@applications/createApplication", function () {
  afterEach(function () {
    return sandbox.restore();
  });

  it("should create an application", async function () {
    // Arrange
    const { createCreateApplication } =
      await import("../../src/applications/createCreateApplication");
    const metadata = new grpc.Metadata();
    metadata.set("token", TEST_TOKEN);

    const applications = {
      application: {
        create: sandbox.stub().resolves({ ref: "123" })
      }
    } as unknown as Database;

    const call = {
      metadata,
      request: {
        name: "My Application",
        type: ApplicationType.EXTERNAL,
        endpoint: "localhost:50061"
      }
    };

    const callback = sandbox.stub();

    // Act
    await createCreateApplication(applications)(call, callback);

    // Assert
    expect(callback).to.have.been.calledOnceWithExactly(null, { ref: "123" });
  });

  it("should throw an error if the application already exists", async function () {
    // Arrange
    const metadata = new grpc.Metadata();
    metadata.set("token", TEST_TOKEN);

    const call = {
      metadata,
      request: {
        name: "My Application",
        type: ApplicationType.EXTERNAL,
        endpoint: "localhost:50061"
      }
    };

    const db = {
      application: {
        create: sandbox
          .stub()
          .throws({ code: DatabaseErrorCode.RECORD_ALREADY_EXISTS })
      }
    } as unknown as Database;

    const { createCreateApplication } =
      await import("../../src/applications/createCreateApplication");

    // Act
    await createCreateApplication(db)(call, (error) => {
      // Assert
      expect(error).to.deep.equal({
        code: grpc.status.ALREADY_EXISTS,
        message: "The resource already exists"
      });
    });
  });
});
