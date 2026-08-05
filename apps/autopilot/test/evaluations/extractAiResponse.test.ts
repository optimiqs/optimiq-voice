import { expect } from "chai";
import { extractAiResponse } from "../../src/models/evaluations/extractAiResponse";

describe("extractAiResponse", () => {
  const baseConfig = {
    conversationSettings: {
      goodbyeMessage: "Bye!",
      transferOptions: { message: "Transferring..." }
    },
    languageModel: {},
    eventsHook: undefined,
    testCases: undefined
  } as Parameters<typeof extractAiResponse>[1];

  it("returns content when no tool calls", () => {
    const out = extractAiResponse(
      { type: "say", content: "Hello there" },
      baseConfig
    );
    expect(out).to.equal("Hello there");
  });

  it("returns goodbyeMessage when first tool is hangup", () => {
    const out = extractAiResponse(
      {
        type: "hangup",
        toolCalls: [{ name: "hangup", args: {} }] as never
      },
      baseConfig
    );
    expect(out).to.equal("Bye!");
  });

  it("returns transfer message when first tool is transfer", () => {
    const out = extractAiResponse(
      {
        type: "transfer",
        toolCalls: [{ name: "transfer", args: {} }] as never
      },
      baseConfig
    );
    expect(out).to.equal("Transferring...");
  });

  it("returns content when first tool is not hangup/transfer", () => {
    const out = extractAiResponse(
      {
        type: "say",
        content: "Ok",
        toolCalls: [{ name: "book", args: {} }] as never
      },
      baseConfig
    );
    expect(out).to.equal("Ok");
  });
});
