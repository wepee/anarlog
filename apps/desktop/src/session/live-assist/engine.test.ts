import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoreApi } from "zustand";

const listener = vi.hoisted(() => ({ store: null as never }));

vi.mock("~/store/zustand/listener/instance", async () => {
  const { createStore } = await import("zustand");
  listener.store = createStore(() => ({
    live: {
      status: "active",
      sessionId: "s1",
      liveTranscriptionActive: true,
    },
    liveSegments: [] as unknown[],
  })) as never;
  return {
    get listenerStore() {
      return listener.store;
    },
  };
});
vi.mock("./journal", () => ({
  liveAssistLog: vi.fn(),
  describeError: (error: unknown) => String(error),
  describeModel: () => ({}),
}));
vi.mock("./answers", () => ({
  buildLiveAnswerPrompt: () => ({ context: "", request: "" }),
  streamLiveAnswer: () => new Promise(() => {}),
}));
vi.mock("./past-meetings", () => ({
  loadPastMeetings: async () => ({ text: "", titles: [] }),
  NO_PAST_MEETINGS: { text: "", titles: [] },
}));
vi.mock("~/services/enhancer/auto-template", () => ({
  listTemplateCandidates: async () => [],
}));
vi.mock("~/services/enhancer/summary-language", () => ({
  resolveSummaryLanguage: async () => "fr",
}));
vi.mock("~/session/content-queries", () => ({
  loadSessionContentSnapshot: async () => null,
}));

import { createLiveAssistEngine } from "./engine";

import { getLiveAssistSession } from "~/store/zustand/live-assist";

function segment(
  id: string,
  channel: "RemoteParty" | "DirectMic",
  startMs: number,
  text: string,
  isFinal: boolean,
) {
  return {
    id,
    key: { channel, speaker_index: 0, speaker_human_id: null },
    start_ms: startMs,
    end_ms: startMs + 2_000,
    text,
    words: [{ is_final: isFinal }],
  };
}

describe("live answers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers a participant's question within seconds, even while the user keeps talking", async () => {
    vi.useFakeTimers();
    const engine = createLiveAssistEngine(() => ({
      enabled: true,
      model: {} as LanguageModel,
      modelId: "claude-haiku-5-5",
      providerId: "anthropic",
      language: "fr",
      spokenLanguages: [],
      useMainLanguage: false,
      webSearch: false,
      autoAnswers: true,
      projectsCommand: "",
    }));
    engine.sync();

    const store = listener.store as StoreApi<{ liveSegments: unknown[] }>;
    const question = segment(
      "r1",
      "RemoteParty",
      0,
      "Et vous facturez combien pour un audit complet ?",
      true,
    );
    store.setState({ liveSegments: [question] });
    // The user starts answering: their partial words keep coming in.
    for (let index = 0; index < 15; index += 1) {
      await vi.advanceTimersByTimeAsync(300);
      store.setState({
        liveSegments: [
          question,
          segment("m1", "DirectMic", 2_500, "Alors ".repeat(index + 1), false),
        ],
      });
    }

    expect(
      getLiveAssistSession("s1").answers.map((answer) => answer.question),
    ).toEqual(["Et vous facturez combien pour un audit complet ?"]);
    engine.dispose();
  });
});
