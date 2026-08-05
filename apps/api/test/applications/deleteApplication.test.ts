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

const appRef = "3c459670-efa0-4404-8671-b6f36c3da11d";

describe("@applications/deleteApplication", function () {
  afterEach(function () {
    return sandbox.restore();
  });

  it("should delete an application", async function () {
    // Arrange
    const metadata = new grpc.Metadata();
    metadata.set("token", TEST_TOKEN);

    const call = {
      metadata,
      request: {
        ref: appRef
      }
    };

    const res = {
      ref: appRef
    };

    const db = {
      application: {
        delete: sandbox.stub().resolves(res),
        findUnique: sandbox.stub().resolves({
          accessKeyId: "GRahn02s8tgdfghz72vb0fz538qpb5z35p"
        })
      }
    } as unknown as Database;

    const { createDeleteApplication } =
      await import("../../src/applications/createDeleteApplication");

    // Act
    await createDeleteApplication(db)(call, (_, response) => {
      // Assert
      expect(response).to.have.property("ref", appRef);
    });
  });
});
