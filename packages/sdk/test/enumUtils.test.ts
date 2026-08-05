import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import sinonChai from "sinon-chai";
import { MappingTuple } from "../src/client/types";

chai.use(chaiAsPromised);
chai.use(sinonChai);

enum ExampleEnum {
  VALUE1 = 0,
  VALUE2 = 1
}

const enumMapping = [["test", ExampleEnum]] as MappingTuple<unknown>;

describe("@sdk[client/utils]", function () {
  it("should verify if a key is an enum", async function () {
    // Arrange
    const { isMapping } = await import("../src/client/utils");

    // Act
    const result = isMapping("test", enumMapping);

    // Assert
    expect(result).to.be.true;
  });

  it("should return the enum value", async function () {
    // Arrange
    const { getEnumValue } = await import("../src/client/utils");

    // Act
    const result = getEnumValue("test", "VALUE1", enumMapping);

    // Assert
    expect(result).to.be.equal(ExampleEnum.VALUE1);
  });

  it("should return the enum key", async function () {
    // Arrange
    const { getEnumKey } = await import("../src/client/utils");

    // Act
    const result = getEnumKey("test", ExampleEnum.VALUE1, enumMapping);

    // Assert
    expect(result).to.be.equal("VALUE1");
  });
});
