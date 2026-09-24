import { describe, expect, it, vi } from "vitest";

const streamText = vi.fn();

vi.mock("ai", () => ({
  generateId: () => "id",
  streamText: (...args: unknown[]) => streamText(...args),
}));

vi.mock("@anlg/plugin-template", () => ({
  commands: {
    render: async () => ({ status: "ok", data: "prompt" }),
  },
}));

vi.mock("./preferred-names", () => ({
  appendPreferredNamesGuidance: (prompt: string) => prompt,
}));

const { titleWorkflow } = await import("./title-workflow");

async function runWorkflow(finishReason: string) {
  streamText.mockReturnValue({
    textStream: (async function* () {
      yield "Cadrage accompagn";
    })(),
    finishReason: Promise.resolve(finishReason),
  });

  const chunks: string[] = [];
  const stream = titleWorkflow.executeWorkflow({
    model: {} as never,
    args: { language: "fr", enhancedNote: "note", dictionaryTerms: [] },
    onProgress: () => {},
    signal: new AbortController().signal,
  });

  for await (const chunk of stream) {
    if (chunk.type === "text-delta") {
      chunks.push(chunk.text);
    }
  }

  return chunks;
}

describe("title workflow", () => {
  it("leaves room for reasoning tokens before the title", async () => {
    await runWorkflow("stop");
    expect(streamText.mock.calls[0]?.[0].maxOutputTokens).toBe(2_048);
  });

  it("fails instead of yielding a title the model was cut off mid-word", async () => {
    await expect(runWorkflow("length")).rejects.toThrow(/cut off/u);
  });
});
