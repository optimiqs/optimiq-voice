import { ToolEvaluationReport } from "@optimiq-voice/types";
import { isValidIso8601Date } from "./isValidIso8601Date";
import { EvalExpectedTool } from "./types";

type ToolCallLike = { name: string; args?: Record<string, unknown> };

export function evaluateSingleTool(
  expected: EvalExpectedTool,
  actual: ToolCallLike
): ToolEvaluationReport {
  let passed = true;
  let errorMessage = "";

  if (actual.name !== expected.tool) {
    passed = false;
    errorMessage = `Expected tool "${expected.tool}" but got "${actual.name}".`;
  }

  const expectedParams = expected.parameters ?? {};
  const actualParams = actual.args ?? {};

  for (const key of Object.keys(expectedParams)) {
    const expectedVal = expectedParams[key];
    const expectedStr =
      typeof expectedVal === "string"
        ? expectedVal.trim()
        : String(expectedVal).trim();
    if (expectedStr === "valid-date") {
      if (!isValidIso8601Date(actualParams[key])) {
        passed = false;
        const paramMsg = `Expected parameter "${key}" to be a valid date, but got ${JSON.stringify(actualParams[key])}.`;
        errorMessage = errorMessage ? `${errorMessage} ${paramMsg}` : paramMsg;
      }
      continue;
    }

    if (actualParams[key] !== expectedVal) {
      passed = false;
      const paramMsg = `Expected parameter "${key}" to have value ${JSON.stringify(expectedVal)}, but got ${JSON.stringify(actualParams[key])}.`;
      errorMessage = errorMessage ? `${errorMessage} ${paramMsg}` : paramMsg;
    }
  }

  return {
    expectedTool: expected.tool,
    actualTool: actual.name,
    passed,
    expectedParameters: expected.parameters,
    actualParameters: actual.args,
    errorMessage: errorMessage || undefined
  };
}
