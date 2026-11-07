import { describe, expect, it } from "vitest";

import type { LiveTranscriptSegment } from "@anlg/plugin-transcription";

import {
  buildLiveAssistWindow,
  EMPTY_LIVE_ASSIST_SNAPSHOT,
  type LiveAssistOutput,
  mergeLiveAssistOutput,
  nextLiveAssistTemplate,
  shouldRunLiveAssistUpdate,
} from "./live-assist";

function segment(
  id: string,
  startMs: number,
  endMs: number,
  text: string,
): LiveTranscriptSegment {
  return {
    id,
    key: { channel: "RemoteParty", speaker_index: 0, speaker_human_id: null },
    start_ms: startMs,
    end_ms: endMs,
    text,
    words: [],
  } as unknown as LiveTranscriptSegment;
}

function output(partial: Partial<LiveAssistOutput> = {}): LiveAssistOutput {
  return {
    template: { templateId: null, confidence: "low", evidence: null },
    recent: "",
    topics: [],
    decisions: [],
    todos: [],
    coverage: [],
    questions: [],
    research: [],
    ...partial,
  };
}

describe("buildLiveAssistWindow", () => {
  it("counts only new words but rereads two minutes of overlap", () => {
    const window = buildLiveAssistWindow(
      [
        segment("a", 0, 30_000, "un deux trois"),
        segment("b", 200_000, 230_000, "quatre cinq"),
        segment("c", 240_000, 250_000, "six sept huit neuf"),
      ],
      230_000,
    );

    expect(window.newWords).toBe(4);
    expect(window.text).toContain("quatre cinq");
    expect(window.text).not.toContain("un deux trois");
    expect(window.lastEndMs).toBe(250_000);
  });
});

describe("shouldRunLiveAssistUpdate", () => {
  it("waits for both 45 seconds and 80 new words", () => {
    expect(
      shouldRunLiveAssistUpdate({
        nowMs: 100_000,
        lastRunAtMs: 80_000,
        newWords: 200,
        forced: false,
      }),
    ).toBe(false);
    expect(
      shouldRunLiveAssistUpdate({
        nowMs: 200_000,
        lastRunAtMs: 80_000,
        newWords: 20,
        forced: false,
      }),
    ).toBe(false);
    expect(
      shouldRunLiveAssistUpdate({
        nowMs: 200_000,
        lastRunAtMs: 80_000,
        newWords: 80,
        forced: false,
      }),
    ).toBe(true);
  });
});

describe("mergeLiveAssistOutput", () => {
  it("keeps ids and the new flag of questions, and drops sources it was never given", () => {
    let next = 0;
    const previous = {
      ...EMPTY_LIVE_ASSIST_SNAPSHOT,
      questions: [
        {
          id: "q1",
          text: "Qui décide ?",
          why: "",
          isNew: false,
          sourceUrl: null,
        },
      ],
    };
    const merged = mergeLiveAssistOutput(
      previous,
      output({
        questions: [
          {
            id: "q1",
            text: "Qui décide ?",
            why: "Personne n'a été nommé.",
            sourceUrl: null,
          },
          {
            id: null,
            text: "Quel budget ?",
            why: "Aucun chiffre.",
            sourceUrl: "https://invented.example/page",
          },
          {
            id: null,
            text: "On en reparle ?",
            why: "Écartée.",
            sourceUrl: null,
          },
        ],
      }),
      { dismissed: ["On en reparle ?"], newId: () => `n${(next += 1)}` },
    );

    expect(merged.questions).toEqual([
      {
        id: "q1",
        text: "Qui décide ?",
        why: "Personne n'a été nommé.",
        isNew: false,
        sourceUrl: null,
      },
      {
        id: "n1",
        text: "Quel budget ?",
        why: "Aucun chiffre.",
        isNew: true,
        sourceUrl: null,
      },
    ]);
  });
});

describe("nextLiveAssistTemplate", () => {
  const candidates = [
    { id: "sales", title: "Commercial", description: "", sections: [] },
  ];
  const transcript =
    "[01:00] Speaker 1: on cherche un outil pour gérer nos devis";
  const proven = output({
    template: {
      templateId: "sales",
      confidence: "high",
      evidence: "on cherche un outil pour gérer nos devis",
    },
  });

  it("switches on one cited sentence", () => {
    expect(
      nextLiveAssistTemplate(
        { id: null, source: "auto" },
        proven,
        candidates,
        transcript,
      ),
    ).toEqual({ id: "sales", source: "auto" });
  });

  it("never replaces a template picked by hand", () => {
    expect(
      nextLiveAssistTemplate(
        { id: null, source: "manual" },
        proven,
        candidates,
        transcript,
      ),
    ).toEqual({ id: null, source: "manual" });
  });
});
