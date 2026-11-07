import { type LanguageModel, Output, streamText } from "ai";

import { describeError, describeModel, liveAssistLog } from "./journal";

import { listTemplateCandidates } from "~/services/enhancer/auto-template";
import { loadSessionContentSnapshot } from "~/session/content-queries";
import {
  buildLiveAssistPrompt,
  buildLiveAssistWindow,
  decideLiveAssistTemplate,
  getCoverageLabels,
  LIVE_ASSIST_MIN_INTERVAL_MS,
  LIVE_ASSIST_MIN_NEW_WORDS,
  LIVE_ASSIST_SYSTEM_PROMPT,
  liveAssistOutputSchema,
  mergeLiveAssistOutput,
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
  updates: number;
  lastSkipReason: string | null;
  controller: AbortController | null;
  context: Promise<{ title: string | null; participants: string[] }> | null;
};

// Runs Live Assist for whichever session is recording with live
// transcription, independently of which note (if any) is open: one model call
// per update, at most every 45 seconds and only once 80 new words came in.
// Everything lives in memory and is dropped when the recording stops. Every
// step is written to the Live Assist journal (see ./journal.ts).
export function createLiveAssistEngine(getConfig: () => EngineConfig) {
  let current: RunningSession | null = null;
  let disposed = false;
  let lastInactiveReason: string | null = null;

  liveAssistLog("engine.created");

  const stop = (reason: string) => {
    if (!current) {
      return;
    }
    liveAssistLog(
      "session.stopped",
      { reason, updates: current.updates, running: current.running },
      current.sessionId,
    );
    current.controller?.abort();
    useLiveAssistStore.getState().clearSession(current.sessionId);
    current = null;
  };

  const sync = () => {
    const { live } = listenerStore.getState();
    const config = getConfig();
    const inactiveReason =
      live.status !== "active" || !live.sessionId
        ? null
        : !config.enabled
          ? "setting_disabled"
          : !config.model
            ? "no_language_model"
            : live.liveTranscriptionActive !== true
              ? "no_live_transcription"
              : null;
    const activeSessionId =
      live.status === "active" && live.sessionId && !inactiveReason
        ? live.sessionId
        : null;

    if (inactiveReason !== lastInactiveReason) {
      lastInactiveReason = inactiveReason;
      if (inactiveReason) {
        liveAssistLog(
          "session.not_running",
          {
            reason: inactiveReason,
            liveStatus: live.status,
            liveTranscriptionActive: live.liveTranscriptionActive,
          },
          live.sessionId ?? undefined,
        );
      }
    }

    if (current && current.sessionId !== activeSessionId) {
      stop(
        inactiveReason ??
          (live.status !== "active" ? "recording_stopped" : "session_changed"),
      );
    }
    if (activeSessionId && !current) {
      liveAssistLog(
        "session.started",
        {
          model: describeModel(config.model),
          language: config.language,
          minIntervalMs: LIVE_ASSIST_MIN_INTERVAL_MS,
          minNewWords: LIVE_ASSIST_MIN_NEW_WORDS,
        },
        activeSessionId,
      );
      void refreshTemplates(activeSessionId);
      current = {
        sessionId: activeSessionId,
        processedEndMs: 0,
        lastRunAtMs: null,
        forced: false,
        running: false,
        updates: 0,
        lastSkipReason: null,
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

    const segments = listenerStore.getState().liveSegments;
    const window = buildLiveAssistWindow(segments, session.processedEndMs);
    const nowMs = Date.now();
    if (
      !shouldRunLiveAssistUpdate({
        nowMs,
        lastRunAtMs: session.lastRunAtMs,
        newWords: window.newWords,
        forced: session.forced,
      })
    ) {
      const reason =
        window.newWords < LIVE_ASSIST_MIN_NEW_WORDS && !session.forced
          ? "waiting_for_words"
          : "waiting_for_interval";
      if (reason !== session.lastSkipReason) {
        session.lastSkipReason = reason;
        liveAssistLog(
          "update.waiting",
          {
            reason,
            newWords: window.newWords,
            msSinceLastUpdate:
              session.lastRunAtMs === null ? null : nowMs - session.lastRunAtMs,
            liveSegments: segments.length,
          },
          session.sessionId,
        );
      }
      return;
    }

    session.lastSkipReason = null;
    session.running = true;
    const wasForced = session.forced;
    session.forced = false;
    session.lastRunAtMs = nowMs;
    session.updates += 1;
    const updateNumber = session.updates;
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
      useLiveAssistStore.getState().setTemplates(
        sessionId,
        candidates.map(({ id, title }) => ({ id, title })),
      );
      const before = getLiveAssistSession(sessionId);
      const templateTitle =
        candidates.find((candidate) => candidate.id === before.template.id)
          ?.title ?? "Auto";
      const coverageLabels = getCoverageLabels(
        before.template,
        candidates,
        config.language,
      );
      const prompt = buildLiveAssistPrompt({
        language: config.language,
        title: context.title,
        participants: context.participants,
        template: before.template,
        templateTitle,
        candidates,
        coverageLabels,
        dismissed: before.dismissed,
        snapshot: before.snapshot,
        transcript: window.text,
      });

      liveAssistLog(
        "update.started",
        {
          update: updateNumber,
          forced: wasForced,
          newWords: window.newWords,
          windowChars: window.text.length,
          processedUntilMs: session.processedEndMs,
          template: { ...before.template, title: templateTitle },
          coverageLabels,
          dismissed: before.dismissed,
          candidates: candidates.map(({ id, title }) => ({ id, title })),
          model: describeModel(config.model),
          promptChars: prompt.length,
          prompt,
        },
        sessionId,
      );

      const result = streamText({
        model: config.model,
        system: LIVE_ASSIST_SYSTEM_PROMPT,
        prompt,
        output: Output.object({ schema: liveAssistOutputSchema }),
        abortSignal: controller.signal,
        maxRetries: 1,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        timeout: { totalMs: GENERATION_TIMEOUT_MS },
      });
      const output = await result.output;
      const usage = await Promise.resolve(result.usage).catch(() => null);
      if (controller.signal.aborted || current !== session) {
        liveAssistLog(
          "update.discarded",
          { update: updateNumber, reason: "session_ended_during_update" },
          sessionId,
        );
        return;
      }

      const latest = getLiveAssistSession(sessionId);
      const decision = decideLiveAssistTemplate(
        latest.template,
        output,
        candidates,
        window.text,
      );
      const snapshot = mergeLiveAssistOutput(latest.snapshot, output, {
        dismissed: latest.dismissed,
        newId: () => crypto.randomUUID(),
      });
      const keptIds = new Set(
        snapshot.questions.map((question) => question.id),
      );
      const previousIds = new Set(
        latest.snapshot.questions.map((question) => question.id),
      );
      useLiveAssistStore.getState().applyUpdate(sessionId, {
        snapshot,
        template: decision.template,
        updatedAtMs: Date.now(),
      });
      session.processedEndMs = window.lastEndMs;

      liveAssistLog(
        "update.done",
        {
          update: updateNumber,
          durationMs: Date.now() - nowMs,
          usage,
          output,
          template: {
            proposal: output.template,
            decision: decision.reason,
            before: latest.template,
            after: decision.template,
          },
          questions: {
            shown: snapshot.questions.map(({ id, text }) => ({ id, text })),
            added: snapshot.questions
              .filter((question) => !previousIds.has(question.id))
              .map((question) => question.text),
            removedAsAskedOrAnswered: latest.snapshot.questions
              .filter((question) => !keptIds.has(question.id))
              .map((question) => question.text),
          },
          counts: {
            todos: snapshot.todos.length,
            decisions: snapshot.decisions.length,
            topics: snapshot.topics.length,
            coverage: snapshot.coverage.length,
          },
          processedUntilMs: window.lastEndMs,
        },
        sessionId,
      );

      // New template, new points to cover: evaluate them right away.
      if (decision.template.id !== before.template.id) {
        session.forced = true;
        liveAssistLog(
          "update.rerun_scheduled",
          { reason: "template_changed", templateId: decision.template.id },
          sessionId,
        );
      }
    } catch (error) {
      if (!controller.signal.aborted && current === session) {
        console.error("[live-assist] update failed", error);
        useLiveAssistStore.getState().setStatus(sessionId, "error");
        liveAssistLog(
          "update.failed",
          {
            update: updateNumber,
            durationMs: Date.now() - nowMs,
            error: describeError(error),
            rawText:
              (error as { text?: unknown })?.text !== undefined
                ? String((error as { text?: unknown }).text).slice(0, 4_000)
                : undefined,
          },
          sessionId,
        );
      } else {
        liveAssistLog(
          "update.aborted",
          { update: updateNumber, durationMs: Date.now() - nowMs },
          sessionId,
        );
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
      liveAssistLog(
        "update.rerun_scheduled",
        { reason: "template_picked_by_hand", templateId: next.id },
        sessionId,
      );
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
      stop("engine_disposed");
      liveAssistLog("engine.disposed");
    },
  };
}

async function refreshTemplates(sessionId: string) {
  const candidates = await listTemplateCandidates().catch((error) => {
    liveAssistLog("templates.load_failed", describeError(error), sessionId);
    return [];
  });
  useLiveAssistStore.getState().setTemplates(
    sessionId,
    candidates.map(({ id, title }) => ({ id, title })),
  );
}

async function loadCallContext(sessionId: string) {
  const snapshot = await loadSessionContentSnapshot(sessionId).catch(
    (error) => {
      liveAssistLog("context.load_failed", describeError(error), sessionId);
      return null;
    },
  );
  const context = {
    title: getEventName(snapshot?.event) ?? (snapshot?.title || null),
    participants: (snapshot?.participants ?? [])
      .map((participant) => participant.name)
      .filter(Boolean),
  };
  liveAssistLog("context.loaded", context, sessionId);
  return context;
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
