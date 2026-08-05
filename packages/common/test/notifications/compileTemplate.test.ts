import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@api[common/notifications/compileTemplate]", function () {
  afterEach(function () {
    return sandbox.restore();
  });

  it("should compile a template", async function () {
    // Arrange
    const { compileTemplate } =
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("../../src/notifications/compileTemplate");

    const fsStub = sandbox.replace(
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("fs"),
      "existsSync",
      sandbox.stub().returns(true)
    );

    sandbox.replace(
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("fs"),
      "readFileSync",
      sandbox.stub().returns("Hello {{name}}!")
    );

    // Act
    const result = compileTemplate({
      filePath: "path/to/template.hbs",
      data: { name: "World" }
    });

    // Assert
    expect(result).to.equal("Hello World!");
    expect(fsStub).to.have.been.calledOnce;
    expect(fsStub).to.have.been.calledWith("path/to/template.hbs");
  });
});
