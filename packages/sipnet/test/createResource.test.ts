import * as grpc from "@grpc/grpc-js";
import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { Validators as V } from "@optimiq-voice/common";
import { CreateDomainRequest, Domain, DomainsApi } from "@optimiq-voice/types";
import { getExtendedFieldsHelper } from "./getExtendedFieldsHelper";
import { TEST_TOKEN } from "./testToken";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@sipnet[resources/createResource]", function () {
  afterEach(function () {
    return sandbox.restore();
  });

  it("should create a sipnet resource", async function () {
    // Arrange
    const { createResource } = await import("../src/resources/createResource");
    const metadata = new grpc.Metadata();
    metadata.set("token", TEST_TOKEN);

    const domains = {
      createDomain: sandbox.stub().resolves({ ref: "123" }),
      getDomain: getExtendedFieldsHelper(sandbox)
    } as unknown as DomainsApi;

    const call = {
      metadata,
      request: {
        name: "My Domain",
        domainUri: "sip.optimiq-voice.local",
        accessControlListRef: "123",
        egressPolicies: [],
        extended: {
          accessKeyId: "GRahn02s8tgdfghz72vb0fz538qpb5z35p"
        }
      }
    };

    const callback = sandbox.stub();

    const create = createResource<Domain, CreateDomainRequest, DomainsApi>(
      domains,
      "Domain",
      V.createDomainRequestSchema
    );

    // Act
    await create(call, callback);

    // Assert
    expect(callback).to.have.been.calledOnceWithExactly(null, { ref: "123" });
  });

  it("should throw an error if the sipnet resource already exists", async function () {
    // Arrange
    const { createResource } = await import("../src/resources/createResource");
    const metadata = new grpc.Metadata();
    metadata.set("token", TEST_TOKEN);

    const domains = {
      createDomain: sandbox.stub().throws({
        code: grpc.status.ALREADY_EXISTS,
        message: "The resource already exists"
      }),
      getDomain: getExtendedFieldsHelper(sandbox)
    } as unknown as DomainsApi;

    const call = {
      metadata,
      request: {
        name: "My Domain",
        domainUri: "sip.optimiq-voice.local",
        accessControlListRef: "123",
        egressPolicies: []
      }
    };

    const callback = sandbox.stub();

    const create = createResource<Domain, CreateDomainRequest, DomainsApi>(
      domains,
      "Domain",
      V.createDomainRequestSchema
    );

    // Act
    await create(call, callback);

    // Assert
    expect(callback).to.have.been.calledOnceWithExactly({
      code: grpc.status.ALREADY_EXISTS,
      message: "The resource already exists"
    });
  });
});
