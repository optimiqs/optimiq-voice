/* eslint-disable new-cap */
import * as chai from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@voice/handler/Gather", function () {
  afterEach(function () {
    return sandbox.restore();
  });

  it.skip("needs tests", async function () {
    // Noop
  });
});
