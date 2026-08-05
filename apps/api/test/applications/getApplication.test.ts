import * as grpc from "@grpc/grpc-js";
import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { Database } from "../../src/core/db";
import { TEST_TOKEN } from "../utils";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@applications/getApplication", function () {
  afterEach(function () {
    return sandbox.restore();
  });

  it("should get an application by id", async function () {
    // Arrange
    const metadata = new grpc.Metadata();
    metadata.set("token", TEST_TOKEN);

    const call = {
      metadata,
      request: {
        ref: "123"
      }
    };

    const application = {
      ref: "123",
      name: "My Application",
      endpoint: "example.com:50051",
      accessKeyId: "GRahn02s8tgdfghz72vb0fz538qpb5z35p",
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const db = {
      application: {
        delete: sandbox.stub().resolves({ ref: application.ref }),
        findUnique: sandbox.stub().resolves(application)
      }
    } as unknown as Database;

    const { createGetApplication } =
      await import("../../src/applications/createGetApplication");

    // Act
    const response = await new Promise((resolve, reject) => {
      createGetApplication(db)(call, (error, response) => {
        if (error) return reject(error);
        resolve(response);
      });
    });

    // Assert
    expect(db.application.findUnique).to.have.been.calledTwice;
    expect(response).have.property("ref", application.ref);
    expect(response).have.property("name", application.name);
    expect(response).have.property("endpoint", application.endpoint);
    expect(response).have.property("accessKeyId", application.accessKeyId);
  });

  it("should throw an error if the application is not found", async function () {
    // Arrange
    const metadata = new grpc.Metadata();
    metadata.set("token", TEST_TOKEN);

    const call = {
      metadata,
      request: {
        ref: "123"
      }
    };

    const db = {
      application: {
        findUnique: sandbox.stub().resolves(null)
      }
    } as unknown as Database;

    const { createGetApplication } =
      await import("../../src/applications/createGetApplication");

    // Act
    await createGetApplication(db)(call, (error) => {
      // Assert
      expect(error).to.deep.equal({
        code: grpc.status.NOT_FOUND,
        message: "The requested resource was not found"
      });
    });
  });
});
