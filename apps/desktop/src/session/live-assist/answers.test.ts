import { tool } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

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

function finish(reason: "stop" | "tool-calls", raw: string = reason) {
  return {
    type: "finish",
    finishReason: { unified: reason, raw },
    usage,
  };
}

function modelReplying(reply: string) {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream<unknown>([
        ...text("t1", reply),
        finish("stop"),
      ]) as never,
    }),
  });
}

// First step: a sentence then a read of the notes; second step: the reply.
function modelReadingThen(reply: string) {
  const steps: unknown[][] = [
    [
      ...text("t1", "Je regarde les notes."),
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "read_notes",
        input: JSON.stringify({ search: "prix tarif TJM" }),
      },
      finish("tool-calls"),
    ],
    [...text("t2", reply), finish("stop")],
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
    model: modelReplying(reply),
    providerId: "anthropic",
    modelId: "claude-haiku-5-5",
    prompt: {
      context: "Language: fr",
      request:
        "The user's notes for this question:\n[MEMORY.md › Tarification]\nTJM 600 € HT",
    },
    webTools: null,
    projectRead: null,
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

  it("reads the notes when asked, shows only the final step and cites by label", async () => {
    const shown: string[] = [];
    const reads: unknown[] = [];
    const ref =
      "[[projects/lumen/MEMORY.md#Tarification|MEMORY › Tarification]]";
    const result = await streamLiveAnswer({
      model: modelReadingThen(`La V1 est à 18 000 € HT. ${ref}`),
      providerId: "anthropic",
      modelId: "claude-haiku-5-5",
      prompt: {
        context: "The user's notes on this project:\n(none)",
        request: "",
      },
      webTools: null,
      projectRead: async (query) => {
        reads.push(query);
        return [{ ref, text: "V1 : 18 000 € HT" }];
      },
      onText: (value) => shown.push(value),
    });

    expect(reads).toEqual([{ search: "prix tarif TJM" }]);
    expect(result.text).toBe("La V1 est à 18 000 € HT.");
    expect(result.sources).toEqual([
      { kind: "project", label: "MEMORY › Tarification", url: null },
    ]);
    expect(shown[shown.length - 1]).toBe("La V1 est à 18 000 € HT.");
    expect(shown).toContain("");
  });

  it("cites a note whose name holds brackets", () => {
    const ref =
      "[[projects/Studio/globex/sources/2026-10-01 Tiers payant [3290cd87].md#Transcript|2026-10-01 Tiers payant [3290cd87] › Transcript]]";

    expect(
      extractCitations(`Ils veulent voir les prix des mutuelles. ${ref}`, ref),
    ).toEqual({
      text: "Ils veulent voir les prix des mutuelles.",
      refs: ["2026-10-01 Tiers payant [3290cd87] › Transcript"],
    });
  });
});

describe("a reply that stops mid-way", () => {
  function modelStopping(replies: string[]) {
    const calls: Array<string[]> = [];
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        calls.push((options.tools ?? []).map((item) => item.name));
        return {
          stream: convertArrayToReadableStream<unknown>([
            ...text("t1", replies[call++]!),
            finish("stop", "pause_turn"),
          ]) as never,
        };
      },
    });
    return { model, calls };
  }

  async function answerWith(model: MockLanguageModelV3) {
    return streamLiveAnswer({
      model,
      providerId: "anthropic",
      modelId: "claude-haiku-5-5",
      prompt: { context: "", request: "" },
      webTools: {
        web_search: tool({
          inputSchema: z.object({}),
          execute: async () => "",
        }),
      },
      projectRead: null,
      onText: () => {},
    });
  }

  it("asks again without web search, then keeps only its finished sentences", async () => {
    const { model, calls } = modelStopping([
      "Oui, c'est réaliste : un cockp",
      "Oui, c'est réaliste. Chaque agent peut appeler son propre mod",
    ]);

    const result = await answerWith(model);

    expect(calls).toEqual([["web_search"], []]);
    expect(result.text).toBe("Oui, c'est réaliste.");
    expect(result.skipped).toBe(false);
    expect(result.ends.map((end) => end.raw)).toEqual([
      "pause_turn",
      "pause_turn",
    ]);
  });
});
