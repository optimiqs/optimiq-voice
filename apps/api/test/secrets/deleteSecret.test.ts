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

describe("@secrets/deleteSecret", function () {
  afterEach(function () {
    return sandbox.restore();
  });

  it("should delete a secret", async function () {
    // Arrange
    const metadata = new grpc.Metadata();
    metadata.set("token", TEST_TOKEN);

    const call = {
      metadata,
      request: {
        ref: "123"
      }
    };

    const res = {
      ref: "123"
    };

    const db = {
      secret: {
        delete: sandbox.stub().resolves(res),
        findUnique: sandbox.stub().resolves({
          accessKeyId: "GRahn02s8tgdfghz72vb0fz538qpb5z35p"
        })
      }
    } as unknown as Database;

    const { deleteSecret } = await import("../../src/secrets/deleteSecret");

    // Act
    await deleteSecret(db)(call, (_, response) => {
      // Assert
      expect(response).to.have.property("ref", "123");
    });
  });
});
