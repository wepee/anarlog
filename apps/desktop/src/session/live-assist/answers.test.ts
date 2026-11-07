import { describe, expect, it } from "vitest";

import { getLiveAnswerProviderOptions, isSkippedAnswer } from "./answers";

describe("live answers", () => {
  it("recognizes a declined answer", () => {
    expect(isSkippedAnswer("SKIP")).toBe(true);
    expect(isSkippedAnswer("Skipping the intro, the price is 4 500 €")).toBe(
      false,
    );
  });

  it("only turns thinking off where the model accepts it", () => {
    expect(
      getLiveAnswerProviderOptions("anthropic", "claude-haiku-5-5"),
    ).toEqual({
      anthropic: { thinking: { type: "disabled" } },
    });
    expect(
      getLiveAnswerProviderOptions("anthropic", "claude-opus-5-5"),
    ).toEqual({
      anthropic: { thinking: { type: "adaptive" }, effort: "low" },
    });
    expect(getLiveAnswerProviderOptions("openai", "gpt-5")).toBeUndefined();
  });
});
