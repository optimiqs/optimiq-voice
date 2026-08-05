import { runCommand } from "@oclif/test";
import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@ctl[bug]", function () {
  afterEach(function () {
    return sandbox.restore();
  });

  it("ensures it contains the issue reporting link", async function () {
    const { stdout } = await runCommand("bug");
    expect(stdout).to.contain("Please report bugs to the link below");
    expect(stdout).to.contain(
      "https://github.com/optimiqs/optimiq-voice/issues/new?assignees=&labels=bug&projects=&template=bug_report.yaml&title=%5BBUG%5D%3A+"
    );
  });
});
