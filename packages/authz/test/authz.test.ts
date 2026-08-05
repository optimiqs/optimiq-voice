/* eslint-disable no-invalid-this */
import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@authz", function () {
  afterEach(function () {
    return sandbox.restore();
  });

  it("needs tests", async function () {});
});
