import { type LanguageModel, Output, streamText } from "ai";

import { listTemplateCandidates } from "~/services/enhancer/auto-template";
import { loadSessionContentSnapshot } from "~/session/content-queries";
import {
  buildLiveAssistPrompt,
  buildLiveAssistWindow,
  getCoverageLabels,
  LIVE_ASSIST_SYSTEM_PROMPT,
  liveAssistOutputSchema,
  mergeLiveAssistOutput,
  nextLiveAssistTemplate,
  shouldRunLiveAssistUpdate,
} from "~/session/insights/live-assist";
import { listenerStore } from "~/store/zustand/listener/instance";
import {
  getLiveAssistSession,
  useLiveAssistStore,
} from "~/store/zustand/live-assist";

const TICK_MS = 5_000;
const GENERATION_TIMEOUT_MS = 45_000;
const MAX_OUTPUT_TOKENS = 3_000;

type EngineConfig = {
  enabled: boolean;
  model: LanguageModel | null;
  language: string;
};

type RunningSession = {
  sessionId: string;
  processedEndMs: number;
  lastRunAtMs: number | null;
  forced: boolean;
  running: boolean;
  controller: AbortController | null;
  context: Promise<{ title: string | null; participants: string[] }> | null;
};

// Runs Live Assist for whichever session is recording with live
// transcription, independently of which note (if any) is open: one model call
// per update, at most every 45 seconds and only once 80 new words came in.
// Everything lives in memory and is dropped when the recording stops.
export function createLiveAssistEngine(getConfig: () => EngineConfig) {
  let current: RunningSession | null = null;
  let disposed = false;

  const stop = () => {
    if (!current) {
      return;
    }
    current.controller?.abort();
    useLiveAssistStore.getState().clearSession(current.sessionId);
    current = null;
  };

  const sync = () => {
    const { live } = listenerStore.getState();
    const config = getConfig();
    const activeSessionId =
      config.enabled &&
      config.model &&
      live.status === "active" &&
      live.liveTranscriptionActive === true
        ? live.sessionId
        : null;

    if (current && current.sessionId !== activeSessionId) {
      stop();
    }
    if (activeSessionId && !current) {
      current = {
        sessionId: activeSessionId,
        processedEndMs: 0,
        lastRunAtMs: null,
        forced: false,
        running: false,
        controller: null,
        context: null,
      };
    }
  };

  const tick = async () => {
    sync();
    const session = current;
    const config = getConfig();
    if (disposed || !session || session.running || !config.model) {
      return;
    }

    const window = buildLiveAssistWindow(
      listenerStore.getState().liveSegments,
      session.processedEndMs,
    );
    const nowMs = Date.now();
    if (
      !shouldRunLiveAssistUpdate({
        nowMs,
        lastRunAtMs: session.lastRunAtMs,
        newWords: window.newWords,
        forced: session.forced,
      })
    ) {
      return;
    }

    session.running = true;
    session.forced = false;
    session.lastRunAtMs = nowMs;
    const controller = new AbortController();
    session.controller = controller;
    const { sessionId } = session;
    useLiveAssistStore.getState().setStatus(sessionId, "updating");

    try {
      session.context ??= loadCallContext(sessionId);
      const [context, candidates] = await Promise.all([
        session.context,
        listTemplateCandidates(),
      ]);
      const before = getLiveAssistSession(sessionId);
      const templateTitle =
        candidates.find((candidate) => candidate.id === before.template.id)
          ?.title ?? "Auto";

      const result = streamText({
        model: config.model,
        system: LIVE_ASSIST_SYSTEM_PROMPT,
        prompt: buildLiveAssistPrompt({
          language: config.language,
          title: context.title,
          participants: context.participants,
          template: before.template,
          templateTitle,
          candidates,
          coverageLabels: getCoverageLabels(
            before.template,
            candidates,
            config.language,
          ),
          dismissed: before.dismissed,
          snapshot: before.snapshot,
          transcript: window.text,
        }),
        output: Output.object({ schema: liveAssistOutputSchema }),
        abortSignal: controller.signal,
        maxRetries: 1,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        timeout: { totalMs: GENERATION_TIMEOUT_MS },
      });
      const output = await result.output;
      if (controller.signal.aborted || current !== session) {
        return;
      }

      const latest = getLiveAssistSession(sessionId);
      const template = nextLiveAssistTemplate(
        latest.template,
        output,
        candidates,
        window.text,
      );
      useLiveAssistStore.getState().applyUpdate(sessionId, {
        snapshot: mergeLiveAssistOutput(latest.snapshot, output, {
          dismissed: latest.dismissed,
          newId: () => crypto.randomUUID(),
        }),
        template,
        updatedAtMs: Date.now(),
      });
      session.processedEndMs = window.lastEndMs;
      // New template, new points to cover: evaluate them right away.
      if (template.id !== before.template.id) {
        session.forced = true;
      }
    } catch (error) {
      if (!controller.signal.aborted && current === session) {
        console.error("[live-assist] update failed", error);
        useLiveAssistStore.getState().setStatus(sessionId, "error");
      }
    } finally {
      session.running = false;
      session.controller = null;
    }
  };

  const interval = setInterval(() => void tick(), TICK_MS);
  const unsubscribeListener = listenerStore.subscribe((state, previous) => {
    if (
      state.live.status !== previous.live.status ||
      state.live.sessionId !== previous.live.sessionId ||
      state.live.liveTranscriptionActive !==
        previous.live.liveTranscriptionActive
    ) {
      sync();
    }
  });
  const unsubscribeStore = useLiveAssistStore.subscribe((state, previous) => {
    const sessionId = current?.sessionId;
    if (!sessionId) {
      return;
    }
    const next = state.sessions[sessionId]?.template;
    const before = previous.sessions[sessionId]?.template;
    if (next?.source === "manual" && next !== before && current) {
      current.forced = true;
      void tick();
    }
  });

  return {
    sync,
    dispose: () => {
      disposed = true;
      clearInterval(interval);
      unsubscribeListener();
      unsubscribeStore();
      stop();
    },
  };
}

async function loadCallContext(sessionId: string) {
  const snapshot = await loadSessionContentSnapshot(sessionId).catch(
    () => null,
  );
  return {
    title: getEventName(snapshot?.event) ?? (snapshot?.title || null),
    participants: (snapshot?.participants ?? [])
      .map((participant) => participant.name)
      .filter(Boolean),
  };
}

function getEventName(event: unknown): string | null {
  if (!event || typeof event !== "object") {
    return null;
  }
  const record = event as Record<string, unknown>;
  for (const key of ["name", "title"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return null;
}
