import { expect } from "chai";
import { z } from "zod";
import { convertToolToLangchainTool } from "../src/tools/convertToolToLangchainTool";
import { Tool } from "../src/tools/types";

describe("@autopilot/tools", () => {
  it("should convert a Optimiq Voice tool to a LangChain structured tool", () => {
    // Arrange
    const mockTool: Tool = {
      name: "test_tool",
      description: "A test tool",
      parameters: {
        type: "object",
        properties: {
          testString: {
            type: "string"
          },
          testNumber: {
            type: "number"
          },
          testBoolean: {
            type: "boolean"
          }
        },
        required: ["testString"]
      }
    };

    // Act
    const result = convertToolToLangchainTool(mockTool);

    // Assert
    expect(result.name).to.equal(mockTool.name);
    expect(result.description).to.equal(mockTool.description);
    expect(result.schema).to.be.instanceOf(z.ZodObject);

    // Verify the schema can be used to parse valid data
    const validData = {
      testString: "hello",
      testNumber: 42,
      testBoolean: true
    };
    const parsed = result.schema.parse(validData);
    expect(parsed).to.deep.equal(validData);

    // Verify schema validation works for invalid data
    const invalidData = {
      testString: 123, // Should be a string
      testNumber: "not a number", // Should be a number
      testBoolean: "not a boolean" // Should be a boolean
    };

    try {
      result.schema.parse(invalidData);
      expect.fail("Schema should have thrown an error for invalid data");
    } catch (error) {
      expect(error).to.exist;
    }
  });

  it("should convert a Optimiq Voice tool with no parameters to a LangChain structured tool", () => {
    // Arrange
    const mockTool: Tool = {
      name: "test_tool",
      description: "A test tool"
    };

    // Act
    const result = convertToolToLangchainTool(mockTool);

    // Assert
    expect(result.name).to.equal(mockTool.name);
    expect(result.description).to.equal(mockTool.description);
    expect(result.schema).to.be.instanceOf(z.ZodObject);

    // Verify the schema can be used to parse valid data
    const validData = {};
    const parsed = result.schema.parse(validData);
    expect(parsed).to.deep.equal(validData);
  });
});
