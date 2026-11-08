import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import {
  extractCitations,
  getLiveAnswerProviderOptions,
  isSkippedAnswer,
  streamLiveAnswer,
} from "./answers";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function text(id: string, value: string) {
  return [
    { type: "text-start" as const, id },
    { type: "text-delta" as const, id, delta: value },
    { type: "text-end" as const, id },
  ];
}

function modelReplying(reply: string) {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream<unknown>([
        ...text("t1", reply),
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "end_turn" },
          usage,
        },
      ]) as never,
    }),
  });
}

async function answer(reply: string) {
  const shown: string[] = [];
  const result = await streamLiveAnswer({
    model: modelReplying(reply),
    providerId: "anthropic",
    modelId: "claude-haiku-5-5",
    prompt: {
      context: "Language: fr",
      request:
        "The user's notes for this question:\n[MEMORY.md › Tarification]\nTJM 600 € HT",
    },
    webTools: null,
    onText: (value) => shown.push(value),
  });
  return { result, shown };
}

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

  it("shows only the references it was given, never while they are written", async () => {
    const { result, shown } = await answer(
      "Notre TJM est de 600 € HT. [MEMORY.md › Tarification] [Inventé.md]",
    );

    expect(result.text).toBe("Notre TJM est de 600 € HT.");
    expect(result.skipped).toBe(false);
    expect(result.sources).toEqual([
      { kind: "project", label: "MEMORY.md › Tarification", url: null },
    ]);
    expect(shown.every((value) => !value.includes("["))).toBe(true);
  });

  it("never shows a declined answer", async () => {
    const { result, shown } = await answer("SKIP");

    expect(result.skipped).toBe(true);
    expect(shown).toEqual([]);
  });

  it("keeps brackets that are part of the answer", () => {
    expect(extractCitations("Voir l'article [1]", "").text).toBe(
      "Voir l'article [1]",
    );
  });
});
