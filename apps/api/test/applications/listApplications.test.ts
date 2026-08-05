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

describe("@applications/listApplications", function () {
  afterEach(function () {
    return sandbox.restore();
  });

  it("should list applications", async function () {
    // Arrange
    const metadata = new grpc.Metadata();
    metadata.set("token", TEST_TOKEN);

    const call = {
      metadata,
      request: {
        pageSize: 10,
        pageToken: "1"
      }
    };

    const applications = [
      {
        ref: "123",
        name: "My Application",
        accessKeyId: "GRahn02s8tgdfghz72vb0fz538qpb5z35p",
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ];

    const db = {
      application: {
        findMany: sandbox.stub().resolves(applications)
      }
    } as unknown as Database;

    const { createListApplications } =
      await import("../../src/applications/createListApplications");

    // Act
    const response = await new Promise((resolve, reject) => {
      createListApplications(db)(call, (error, response) => {
        if (error) return reject(error);
        resolve(response);
      });
    });

    // Assert
    expect(response)
      .has.property("items")
      .to.be.an("array")
      .to.have.lengthOf(1);
    // When items.length < pageSize, we're on the last page, so nextPageToken should be empty string
    expect(response).has.property("nextPageToken").to.equal("");
  });

  it("should return nextPageToken when page is full", async function () {
    // Arrange
    const metadata = new grpc.Metadata();
    metadata.set("token", TEST_TOKEN);

    const call = {
      metadata,
      request: {
        pageSize: 2, // Request 2 items
        pageToken: ""
      }
    };

    // Return exactly 2 items (full page)
    const applications = [
      {
        ref: "app-1",
        name: "Application 1",
        accessKeyId: "GRahn02s8tgdfghz72vb0fz538qpb5z35p",
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        ref: "app-2",
        name: "Application 2",
        accessKeyId: "GRahn02s8tgdfghz72vb0fz538qpb5z35p",
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ];

    const db = {
      application: {
        findMany: sandbox.stub().resolves(applications)
      }
    } as unknown as Database;

    const { createListApplications } =
      await import("../../src/applications/createListApplications");

    // Act
    const response = await new Promise((resolve, reject) => {
      createListApplications(db)(call, (error, response) => {
        if (error) return reject(error);
        resolve(response);
      });
    });

    // Assert
    expect(response)
      .has.property("items")
      .to.be.an("array")
      .to.have.lengthOf(2);
    // When items.length === pageSize, there might be more pages, so return nextPageToken
    expect(response)
      .has.property("nextPageToken")
      .to.be.a("string")
      .to.equal("app-2");
  });

  it("should return an empty array if no applications found", async function () {
    // Arrange
    const metadata = new grpc.Metadata();
    metadata.set("token", TEST_TOKEN);

    const call = {
      metadata,
      request: {
        pageSize: 10,
        pageToken: "1"
      }
    };

    const db = {
      application: {
        findMany: sandbox.stub().resolves([])
      }
    } as unknown as Database;

    const { createListApplications } =
      await import("../../src/applications/createListApplications");

    // Act
    const response = await new Promise((resolve, reject) => {
      createListApplications(db)(call, (error, response) => {
        if (error) return reject(error);
        resolve(response);
      });
    });

    // Assert
    expect(response)
      .has.property("items")
      .to.be.an("array")
      .to.have.lengthOf(0);
    expect(response).has.property("nextPageToken").to.equal("");
  });
});
