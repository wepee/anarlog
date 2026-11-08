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

// First step: a sentence then a search; second step: the given reply.
function modelSearchingThen(reply: string) {
  const steps: unknown[][] = [
    [
      ...text("t1", "Je vérifie dans les notes du projet."),
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "search_project",
        input: JSON.stringify({ query: "tarif" }),
      },
      {
        type: "finish",
        finishReason: { unified: "tool-calls", raw: "tool_use" },
        usage,
      },
    ],
    [
      ...text("t2", reply),
      {
        type: "finish",
        finishReason: { unified: "stop", raw: "end_turn" },
        usage,
      },
    ],
  ];
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream(steps[call++]!) as never,
    }),
  });
}

async function answer(reply: string) {
  const shown: string[] = [];
  const result = await streamLiveAnswer({
    model: modelSearchingThen(reply),
    providerId: "anthropic",
    modelId: "claude-haiku-5-5",
    prompt: { context: "Project brief:\n(none)", request: "Question: tarif ?" },
    webTools: null,
    projectSearch: async () => [
      { ref: "MEMORY.md › Tarification", text: "TJM 600 € HT" },
      { ref: "Billing/Devis.md", text: "Devis V1" },
    ],
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

  it("shows only the final step, and only the references it cites", async () => {
    const { result, shown } = await answer(
      "Notre TJM est de 600 € HT. [MEMORY.md › Tarification] [Inventé.md]",
    );

    expect(result.text).toBe("Notre TJM est de 600 € HT.");
    expect(result.skipped).toBe(false);
    expect(result.sources).toEqual([
      { kind: "project", label: "MEMORY.md › Tarification", url: null },
    ]);
    expect(shown[shown.length - 1]).toBe("Notre TJM est de 600 € HT.");
    expect(shown).toContain("");
  });

  it("treats SKIP after a search as declined", async () => {
    const { result } = await answer("SKIP");

    expect(result.skipped).toBe(true);
  });

  it("keeps brackets that are part of the answer", () => {
    expect(extractCitations("Voir l'article [1]", "").text).toBe(
      "Voir l'article [1]",
    );
  });
});
