import * as grpc from "@grpc/grpc-js";
import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { DatabaseErrorCode } from "@optimiq-voice/common";
import { ApplicationType } from "@optimiq-voice/types";
import { TEST_TOKEN, TEST_UUID } from "../utils";
import type { Database } from "../../src/core/db";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@applications/updateApplication", function () {
  afterEach(function () {
    return sandbox.restore();
  });

  it("should update an application", async function () {
    // Arrange
    const metadata = new grpc.Metadata();
    metadata.set("token", TEST_TOKEN);

    const call = {
      metadata,
      request: {
        ref: TEST_UUID,
        name: "My new application name",
        endpoint: "localhost:8765",
        type: ApplicationType.EXTERNAL
      }
    };

    const db = {
      application: {
        update: sandbox.stub().resolves({ ref: TEST_UUID }),
        findUnique: sandbox
          .stub()
          .resolves({ accessKeyId: "GRahn02s8tgdfghz72vb0fz538qpb5z35p" })
      },
      transaction: sandbox.stub().callsFake(async (callback) => callback(db)),
      textToSpeech: {
        deleteMany: sandbox.stub().resolves()
      },
      speechToText: {
        deleteMany: sandbox.stub().resolves()
      },
      intelligence: {
        deleteMany: sandbox.stub().resolves()
      }
    } as unknown as Database;

    const { createUpdateApplication } =
      await import("../../src/applications/createUpdateApplication");

    // Act
    const response = await new Promise((resolve, reject) => {
      createUpdateApplication(db)(call, (error, response) => {
        if (error) return reject(error);
        resolve(response);
      });
    });

    // Assert
    expect(response).to.deep.equal({ ref: TEST_UUID });
  });

  it("should throw an error if the application does not exist", async function () {
    // Arrange
    const metadata = new grpc.Metadata();
    metadata.set("token", TEST_TOKEN);

    const call = {
      metadata,
      request: {
        ref: TEST_UUID,
        name: "My new application name"
      }
    };

    const db = {
      application: {
        update: sandbox
          .stub()
          .throws({ code: DatabaseErrorCode.RECORD_NOT_FOUND }),
        findUnique: sandbox.stub().resolves(null)
      }
    } as unknown as Database;

    const { createUpdateApplication } =
      await import("../../src/applications/createUpdateApplication");

    // Act
    const response = new Promise((resolve, reject) => {
      createUpdateApplication(db)(call, (error, response) => {
        if (error) return reject(error);
        resolve(response);
      });
    });

    // Assert
    await expect(response).to.be.rejectedWith(
      "The requested resource was not found"
    );
  });
});
