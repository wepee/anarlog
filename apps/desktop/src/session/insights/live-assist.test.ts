import { describe, expect, it } from "vitest";

import type { LiveTranscriptSegment } from "@anlg/plugin-transcription";

import {
  buildLiveAssistWindow,
  detectIncomingQuestions,
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
          },
          {
            id: null,
            text: "Quel budget ?",
            why: "Aucun chiffre.",
          },
          {
            id: null,
            text: "On en reparle ?",
            why: "Écartée.",
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
      },
      {
        id: "n1",
        text: "Quel budget ?",
        why: "Aucun chiffre.",
        isNew: true,
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

describe("detectIncomingQuestions", () => {
  it("picks finished questions from every speaker, with or without a question mark", () => {
    const remote = segment(
      "r",
      1_000,
      5_000,
      "Super. Et vous facturez combien pour un audit complet ? Ok.",
    );
    const self = {
      ...segment("s", 6_000, 8_000, "Vous avez quel budget pour ce projet ?"),
      key: { channel: "DirectMic" },
    } as unknown as LiveTranscriptSegment;
    const short = segment("x", 9_000, 9_500, "Ah bon ?");
    const unpunctuated = segment(
      "u",
      10_000,
      12_000,
      "est-ce que vous pouvez m'envoyer le devis",
    );

    const result = detectIncomingQuestions(
      [remote, self, short, unpunctuated],
      0,
    );

    expect(
      result.questions.map(({ text, speaker }) => ({ text, speaker })),
    ).toEqual([
      {
        text: "Et vous facturez combien pour un audit complet ?",
        speaker: "Speaker 1",
      },
      { text: "Vous avez quel budget pour ce projet ?", speaker: "You" },
      {
        text: "est-ce que vous pouvez m'envoyer le devis",
        speaker: "Speaker 1",
      },
    ]);
    expect(result.lastEndMs).toBe(12_000);
  });

  it("joins a question split across one speaker's segments and waits for unfinished ones", () => {
    const first = segment("a", 1_000, 2_000, "D'accord. Et pour la mise en");
    const second = segment(
      "b",
      2_000,
      3_000,
      "production, vous comptez combien de temps ?",
    );
    const pending = {
      ...segment("c", 4_000, 5_000, "Et le budget ?"),
      key: { channel: "RemoteParty", speaker_index: 1, speaker_human_id: null },
      words: [{ is_final: false }],
    } as unknown as LiveTranscriptSegment;

    const result = detectIncomingQuestions([pending, second, first], 0);

    expect(result.questions.map((question) => question.text)).toEqual([
      "Et pour la mise en production, vous comptez combien de temps ?",
    ]);
    expect(result.lastEndMs).toBe(3_000);
  });
});
