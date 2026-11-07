import { type LanguageModel, Output, streamText } from "ai";

import { buildLiveAnswerPrompt, streamLiveAnswer } from "./answers";
import { describeError, describeModel, liveAssistLog } from "./journal";
import {
  buildProjectContext,
  EMPTY_PROJECT_CONTEXT,
  type ProjectContext,
} from "./project-context";
import { getWebSearchTools } from "./research";

import { listTemplateCandidates } from "~/services/enhancer/auto-template";
import { resolveSummaryLanguage } from "~/services/enhancer/summary-language";
import { loadSessionContentSnapshot } from "~/session/content-queries";
import {
  buildLiveAssistPrompt,
  buildLiveAssistWindow,
  decideLiveAssistTemplate,
  detectIncomingQuestions,
  getCoverageLabels,
  LIVE_ASSIST_MIN_INTERVAL_MS,
  LIVE_ASSIST_MIN_NEW_WORDS,
  LIVE_ASSIST_SYSTEM_PROMPT,
  liveAssistOutputSchema,
  mergeLiveAssistOutput,
  shouldRunLiveAssistUpdate,
  summarizeSnapshotForAnswers,
} from "~/session/insights/live-assist";
import { listenerStore } from "~/store/zustand/listener/instance";
import {
  getLiveAssistSession,
  useLiveAssistStore,
} from "~/store/zustand/live-assist";

const TICK_MS = 5_000;
const GENERATION_TIMEOUT_MS = 45_000;
const MAX_OUTPUT_TOKENS = 3_000;
const MAX_AUTO_ANSWERS_PER_CALL = 60;
const ANSWER_CONTEXT_MS = 3 * 60_000;
// A turn is considered finished once the transcript has been quiet this long.
const QUESTION_QUIET_MS = 1_200;
const ANSWER_RENDER_INTERVAL_MS = 120;

type EngineConfig = {
  enabled: boolean;
  model: LanguageModel | null;
  modelId: string;
  providerId: string;
  language: string;
  spokenLanguages: string[];
  useMainLanguage: boolean;
  webSearch: boolean;
  autoAnswers: boolean;
  obsidianPath: string;
};

type CallContext = { title: string | null; participants: string[] };

type RunningSession = {
  sessionId: string;
  processedEndMs: number;
  lastRunAtMs: number | null;
  forced: boolean;
  running: boolean;
  updates: number;
  lastSkipReason: string | null;
  controller: AbortController | null;
  context: Promise<CallContext> | null;
  project: Promise<ProjectContext> | null;
  questionsScannedEndMs: number;
  seenQuestions: Set<string>;
  autoAnswers: number;
  answering: boolean;
};

// Runs Live Assist for whichever session is recording with live
// transcription, independently of which note (if any) is open. Two loops:
// the Live Assist update (one model call at most every 45 seconds once 80
// new words came in) and live answers (as soon as a participant's turn ends
// with a question, or when the user asks one). Everything lives in memory
// and is dropped when the recording stops; every step goes to the Live
// Assist journal (see ./journal.ts).
export function createLiveAssistEngine(getConfig: () => EngineConfig) {
  let current: RunningSession | null = null;
  let disposed = false;
  let lastInactiveReason: string | null = null;
  let questionTimer: ReturnType<typeof setTimeout> | null = null;

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
          model: { ...describeModel(config.model), id: config.modelId },
          mainLanguage: config.language,
          additionalLanguages: config.spokenLanguages,
          useMainLanguage: config.useMainLanguage,
          webSearch: config.webSearch
            ? getWebSearchTools(config.model)
              ? "on"
              : "unsupported_by_provider"
            : "off",
          autoAnswers: config.autoAnswers,
          obsidianVault: config.obsidianPath || null,
          minIntervalMs: LIVE_ASSIST_MIN_INTERVAL_MS,
          minNewWords: LIVE_ASSIST_MIN_NEW_WORDS,
        },
        activeSessionId,
      );
      void refreshTemplates(activeSessionId);
      const session: RunningSession = {
        sessionId: activeSessionId,
        processedEndMs: 0,
        lastRunAtMs: null,
        forced: false,
        running: false,
        updates: 0,
        lastSkipReason: null,
        controller: null,
        context: null,
        project: null,
        questionsScannedEndMs: 0,
        seenQuestions: new Set(),
        autoAnswers: 0,
        answering: false,
      };
      current = session;
      // The project brief is ready, or on its way, before the first question.
      session.context = loadCallContext(activeSessionId);
      session.project = loadProject(session, config);
    }
  };

  const loadProject = async (
    session: RunningSession,
    config: EngineConfig,
  ): Promise<ProjectContext> => {
    const startedAt = Date.now();
    const context = await (session.context ??
      loadCallContext(session.sessionId));
    const project = await buildProjectContext({
      sessionId: session.sessionId,
      title: context.title,
      participants: context.participants,
      obsidianPath: config.obsidianPath,
      onError: (source, error) =>
        liveAssistLog(
          "project.source_failed",
          { source, error: describeError(error) },
          session.sessionId,
        ),
    }).catch((error) => {
      liveAssistLog("project.failed", describeError(error), session.sessionId);
      return EMPTY_PROJECT_CONTEXT;
    });
    liveAssistLog(
      "project.loaded",
      {
        durationMs: Date.now() - startedAt,
        chars: project.text.length,
        pastMeetings: project.pastMeetings,
        obsidianNotes: project.obsidianNotes,
        text: project.text,
      },
      session.sessionId,
    );
    return project;
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
      const language = await resolveCallLanguage(config, window.text);
      const coverageLabels = getCoverageLabels(
        before.template,
        candidates,
        language,
      );
      const prompt = buildLiveAssistPrompt({
        language,
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
          language,
          newWords: window.newWords,
          windowChars: window.text.length,
          processedUntilMs: session.processedEndMs,
          template: { ...before.template, title: templateTitle },
          coverageLabels,
          dismissed: before.dismissed,
          candidates: candidates.map(({ id, title, description }) => ({
            id,
            title,
            hasDescription: description.trim().length > 0,
          })),
          model: { ...describeModel(config.model), id: config.modelId },
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

  const scanQuestions = () => {
    const session = current;
    const config = getConfig();
    if (!session) {
      return;
    }
    const { questions, lastEndMs } = detectIncomingQuestions(
      listenerStore.getState().liveSegments,
      session.questionsScannedEndMs,
    );
    session.questionsScannedEndMs = lastEndMs;
    if (!config.autoAnswers) {
      return;
    }
    for (const question of questions) {
      const key = question.text.toLowerCase().replace(/\s+/g, " ");
      if (session.seenQuestions.has(key)) {
        continue;
      }
      session.seenQuestions.add(key);
      if (session.autoAnswers >= MAX_AUTO_ANSWERS_PER_CALL) {
        liveAssistLog(
          "answer.skipped",
          { question: question.text, reason: "limit_reached" },
          session.sessionId,
        );
        continue;
      }
      session.autoAnswers += 1;
      useLiveAssistStore.getState().queueAnswer(session.sessionId, {
        id: crypto.randomUUID(),
        question: question.text,
        origin: "auto",
      });
      liveAssistLog(
        "answer.question_detected",
        {
          question: question.text,
          turnEndedAtMs: question.endMs,
          detectedAfterTurnEndMs: Date.now(),
        },
        session.sessionId,
      );
    }
    void processAnswers(session);
  };

  const processAnswers = async (session: RunningSession) => {
    const config = getConfig();
    if (session.answering || current !== session || !config.model) {
      return;
    }
    const { sessionId } = session;
    const next = getLiveAssistSession(sessionId)
      .answers.filter((answer) => answer.status === "queued")
      .sort(
        (a, b) =>
          (a.origin === "asked" ? 0 : 1) - (b.origin === "asked" ? 0 : 1) ||
          a.createdAtMs - b.createdAtMs,
      )[0];
    if (!next) {
      return;
    }

    session.answering = true;
    const store = useLiveAssistStore.getState();
    store.updateAnswer(sessionId, next.id, { status: "answering" });
    const startedAt = Date.now();
    try {
      session.context ??= loadCallContext(sessionId);
      session.project ??= loadProject(session, config);
      const segments = listenerStore.getState().liveSegments;
      const lastEndMs = segments.reduce(
        (max, segment) => Math.max(max, segment.end_ms),
        0,
      );
      const transcript = buildLiveAssistWindow(
        segments,
        lastEndMs - ANSWER_CONTEXT_MS + 120_000,
      ).text;
      const [context, project, language] = await Promise.all([
        session.context,
        session.project,
        resolveCallLanguage(config, transcript),
      ]);
      const webTools = config.webSearch
        ? getWebSearchTools(config.model)
        : null;
      const prompt = buildLiveAnswerPrompt({
        question: next.question,
        origin: next.origin,
        language,
        callTitle: context.title,
        callState: summarizeSnapshotForAnswers(
          getLiveAssistSession(sessionId).snapshot,
        ),
        transcript,
        projectContext: project.text,
      });
      liveAssistLog(
        "answer.started",
        {
          id: next.id,
          origin: next.origin,
          question: next.question,
          language,
          model: config.modelId,
          web: Boolean(webTools),
          projectContextChars: project.text.length,
          waitedInQueueMs: startedAt - next.createdAtMs,
          promptChars: prompt.length,
        },
        sessionId,
      );

      let lastRenderAt = 0;
      const result = await streamLiveAnswer({
        model: config.model,
        providerId: config.providerId,
        modelId: config.modelId,
        prompt,
        webTools,
        onText: (text) => {
          const now = Date.now();
          if (
            current !== session ||
            now - lastRenderAt < ANSWER_RENDER_INTERVAL_MS
          ) {
            return;
          }
          lastRenderAt = now;
          store.updateAnswer(sessionId, next.id, { answer: text });
        },
      });
      if (current !== session) {
        return;
      }
      if (result.skipped) {
        if (next.origin === "auto") {
          store.removeAnswer(sessionId, next.id);
        } else {
          store.updateAnswer(sessionId, next.id, { status: "error" });
        }
      } else {
        store.updateAnswer(sessionId, next.id, {
          status: "ready",
          answer: result.text,
          sources: result.sources,
        });
      }
      liveAssistLog(
        "answer.done",
        {
          id: next.id,
          skipped: result.skipped,
          firstTextMs: result.firstTextMs,
          durationMs: Date.now() - startedAt,
          text: result.text,
          sources: result.sources,
        },
        sessionId,
      );
    } catch (error) {
      if (current === session) {
        store.updateAnswer(sessionId, next.id, { status: "error" });
      }
      liveAssistLog(
        "answer.failed",
        {
          id: next.id,
          durationMs: Date.now() - startedAt,
          error: describeError(error),
        },
        sessionId,
      );
    } finally {
      session.answering = false;
      if (current === session) {
        void processAnswers(session);
      }
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
    if (state.liveSegments !== previous.liveSegments && current) {
      if (questionTimer) clearTimeout(questionTimer);
      questionTimer = setTimeout(() => {
        questionTimer = null;
        scanQuestions();
      }, QUESTION_QUIET_MS);
    }
  });
  const unsubscribeStore = useLiveAssistStore.subscribe((state, previous) => {
    const session = current;
    if (!session) {
      return;
    }
    const { sessionId } = session;
    const answers = state.sessions[sessionId]?.answers;
    if (
      answers !== previous.sessions[sessionId]?.answers &&
      answers?.some((answer) => answer.status === "queued")
    ) {
      void processAnswers(session);
    }
    const next = state.sessions[sessionId]?.template;
    const before = previous.sessions[sessionId]?.template;
    if (next?.source === "manual" && next !== before) {
      session.forced = true;
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
      if (questionTimer) clearTimeout(questionTimer);
      unsubscribeListener();
      unsubscribeStore();
      stop("engine_disposed");
      liveAssistLog("engine.disposed");
    },
  };
}

// Live Assist writes in the language the call is held in, picked among the
// main and additional languages like the summary does.
async function resolveCallLanguage(
  config: EngineConfig,
  text: string,
): Promise<string> {
  const language = await resolveSummaryLanguage(
    {
      ai_language: config.language,
      spoken_languages: JSON.stringify(config.spokenLanguages),
      summary_use_main_language: config.useMainLanguage,
    },
    [text],
  ).catch(() => null);
  return language ?? config.language;
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

async function loadCallContext(sessionId: string): Promise<CallContext> {
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
