import * as grpc from "@grpc/grpc-js";
import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { Database } from "../../src/db";
import { TEST_TOKEN } from "../utils";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@identity[workspaces/listWorkspaces]", function () {
  afterEach(function () {
    return sandbox.restore();
  });

  it("should list workspaces", async function () {
    // Arrange
    const metadata = new grpc.Metadata();
    metadata.set("token", TEST_TOKEN);

    const call = {
      metadata,
      request: {}
    };

    const workspaces = [
      {
        ref: "123",
        name: "My Workspace",
        ownerRef: "123",
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ];

    const db = {
      workspace: {
        findMany: sandbox.stub().resolves(workspaces)
      }
    } as unknown as Database;

    const { createListWorkspaces } =
      await import("../../src/workspaces/createListWorkspaces");

    // Act
    const response = (await new Promise((resolve, reject) => {
      createListWorkspaces(db)(call, (error, response) => {
        if (error) return reject(error);
        resolve(response as { items: unknown[] });
      });
    })) as { items: unknown[] };

    // Assert
    expect(response).to.have.property("items");
    expect(response).to.have.property("nextPageToken");
    expect(response.items.length).to.be.greaterThan(0);
  });

  it("should return an empty array if no workspaces found", async function () {
    // Arrange
    const metadata = new grpc.Metadata();
    metadata.set("token", TEST_TOKEN);

    const call = {
      metadata,
      request: {}
    };

    const db = {
      workspace: {
        findMany: sandbox.stub().resolves([])
      }
    } as unknown as Database;

    const { createListWorkspaces } =
      await import("../../src/workspaces/createListWorkspaces");

    // Act
    const response = (await new Promise((resolve, reject) => {
      createListWorkspaces(db)(call, (error, response) => {
        if (error) return reject(error);
        resolve(response as { items: unknown[] });
      });
    })) as { items: unknown[] };

    // Assert
    expect(response).to.have.property("items");
    expect(response.items.length).to.equal(0);
  });
});
