import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoreApi } from "zustand";

const listener = vi.hoisted(() => ({ store: null as never }));
const pastMeetings = vi.hoisted(() => ({
  load: vi.fn(async () => ({ text: "", titles: [] as string[] })),
}));

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
  loadPastMeetings: pastMeetings.load,
  NO_PAST_MEETINGS: { text: "", titles: [] },
}));
vi.mock("~/services/enhancer/summary-language", () => ({
  resolveSummaryLanguage: async () => "fr",
}));
const mocks = vi.hoisted(() => ({
  snapshot: null as unknown,
  listProjects: vi.fn(async () => []),
}));
vi.mock("~/session/content-queries", () => ({
  loadSessionContentSnapshot: async () => mocks.snapshot,
}));
vi.mock("./projects", () => ({
  listProjects: mocks.listProjects,
  loadProjectContext: async () => "",
  readProject: async () => [],
}));

import { createLiveAssistEngine } from "./engine";

import {
  getLiveAssistSession,
  useLiveAssistStore,
} from "~/store/zustand/live-assist";

const config = {
  enabled: true,
  model: {} as LanguageModel,
  modelId: "claude-haiku-5-5",
  providerId: "anthropic",
  language: "fr",
  spokenLanguages: [],
  useMainLanguage: false,
  webSearch: false,
  autoAnswers: true,
  projectContext: true,
  projectsCommand: "",
};

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
      projectContext: false,
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

  it("answers from the model and the call alone unless project context is on", async () => {
    for (const projectContext of [false, true]) {
      pastMeetings.load.mockClear();
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
        projectContext,
        projectsCommand: "",
      }));
      engine.sync();
      await Promise.resolve();

      expect(pastMeetings.load).toHaveBeenCalledTimes(projectContext ? 1 : 0);
      engine.dispose();
    }
  });

  it("sends the projects command the other participants, never the user", async () => {
    mocks.snapshot = {
      title: "Point hebdo Lumen",
      event: null,
      ownerUserId: "me",
      participants: [
        { humanId: "me", name: "Adam", email: "adam@agence.fr", jobTitle: "" },
        {
          humanId: "h2",
          name: "Claire Morel",
          email: "claire.morel@lumen-optique.fr",
          jobTitle: "",
        },
      ],
    };
    const engine = createLiveAssistEngine(() => ({
      ...config,
      projectsCommand: "memex",
    }));
    engine.sync();
    await vi.waitFor(() => expect(mocks.listProjects).toHaveBeenCalled());

    expect(mocks.listProjects).toHaveBeenCalledWith("memex", {
      title: "Point hebdo Lumen",
      participants: [
        { name: "Claire Morel", email: "claire.morel@lumen-optique.fr" },
      ],
    });
    engine.dispose();
  });

  it("keeps the picked project when the recording of the same call restarts, not for another call", async () => {
    mocks.snapshot = null;
    mocks.listProjects.mockResolvedValue([
      { id: "projects/Brain", label: "Brain" },
    ] as never);
    const live = listener.store as StoreApi<{
      live: {
        status: string;
        sessionId: string | null;
        liveTranscriptionActive: boolean;
      };
    }>;
    const record = (sessionId: string | null) =>
      live.setState({
        live: {
          status: sessionId ? "active" : "inactive",
          sessionId,
          liveTranscriptionActive: true,
        },
      });
    const projectsLoaded = (sessionId: string) =>
      vi.waitFor(() =>
        expect(getLiveAssistSession(sessionId).projects).toHaveLength(1),
      );

    record("first");
    const engine = createLiveAssistEngine(() => ({
      ...config,
      projectsCommand: "memex",
    }));
    engine.sync();
    await projectsLoaded("first");
    useLiveAssistStore.getState().selectProject("first", "projects/Brain");

    record(null);
    record("restart");
    await projectsLoaded("restart");
    expect(getLiveAssistSession("restart").projectId).toBe("projects/Brain");

    mocks.snapshot = {
      title: "Point hebdo Lumen",
      event: null,
      ownerUserId: "me",
      participants: [],
    };
    record(null);
    record("other");
    await projectsLoaded("other");
    expect(getLiveAssistSession("other").projectId).toBeNull();

    engine.dispose();
    record("s1");
  });
});
