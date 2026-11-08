import { t } from "@lingui/core/macro";
import { type LanguageModel, Output, streamText } from "ai";

import type { LiveTranscriptSegment } from "@anlg/plugin-transcription";

import { buildLiveAnswerPrompt, streamLiveAnswer } from "./answers";
import { describeError, describeModel, liveAssistLog } from "./journal";
import {
  loadPastMeetings,
  NO_PAST_MEETINGS,
  type PastMeetings,
} from "./past-meetings";
import {
  loadProjectContext,
  type ProjectOption,
  readProject,
  routeCall,
} from "./projects";
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
} from "~/session/insights/live-assist";
import { listenerStore } from "~/store/zustand/listener/instance";
import {
  getLiveAssistSession,
  useLiveAssistStore,
} from "~/store/zustand/live-assist";

const TICK_MS = 5_000;
const GENERATION_TIMEOUT_MS = 45_000;
const MAX_OUTPUT_TOKENS = 6_000;
const MAX_AUTO_ANSWERS_PER_CALL = 60;
const ANSWER_CONTEXT_MS = 3 * 60_000;
// Questions are looked for once the transcript has been quiet this long, and
// at least this often while people keep talking.
const QUESTION_QUIET_MS = 1_200;
const QUESTION_MAX_WAIT_MS = 4_000;
const QUESTION_SCAN_MS = 400;
const ANSWER_RENDER_INTERVAL_MS = 120;
// Until the call's project is known, it is looked for again this often.
const ROUTE_INTERVAL_MS = 45_000;
// An answer waits this long at most for a project context still loading.
const CONTEXT_WAIT_MS = 3_000;

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
  projectsCommand: string;
};

type CallContext = {
  title: string | null;
  participants: Array<{ name: string; email: string | null }>;
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
  context: Promise<CallContext> | null;
  pastMeetings: Promise<PastMeetings> | null;
  projects: ProjectOption[];
  projectContexts: Map<string, Promise<string>>;
  routing: boolean;
  routedAt: number | null;
  questionsScannedEndMs: number;
  seenQuestions: Set<string>;
  autoAnswers: number;
  answering: AbortController | null;
  transcriptChangedAt: number;
  transcriptSignature: string;
  scannedSignature: string;
  scannedAt: number;
  nextId: number;
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
    current.answering?.abort();
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
          projectsCommand: config.projectsCommand.trim() || null,
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
        pastMeetings: null,
        projects: [],
        projectContexts: new Map(),
        routing: false,
        routedAt: null,
        questionsScannedEndMs: 0,
        seenQuestions: new Set(),
        autoAnswers: 0,
        answering: null,
        transcriptChangedAt: Date.now(),
        transcriptSignature: "",
        scannedSignature: "",
        scannedAt: Date.now(),
        nextId: 0,
      };
      current = session;
      // What the user knows about the project is ready, or on its way,
      // before the first question.
      session.context = loadCallContext(activeSessionId);
      session.pastMeetings = loadPastMeetingsFor(session);
      void route(session);
    }
  };

  const loadPastMeetingsFor = async (
    session: RunningSession,
  ): Promise<PastMeetings> => {
    const startedAt = Date.now();
    const past = await loadPastMeetings(session.sessionId).catch((error) => {
      liveAssistLog(
        "past_meetings.failed",
        describeError(error),
        session.sessionId,
      );
      return NO_PAST_MEETINGS;
    });
    liveAssistLog(
      "past_meetings.loaded",
      {
        durationMs: Date.now() - startedAt,
        meetings: past.titles,
        chars: past.text.length,
      },
      session.sessionId,
    );
    return past;
  };

  // Finds the call's project with the user's projects command, and the list
  // of projects sorted by fit for the picker.
  const route = async (session: RunningSession) => {
    const command = getConfig().projectsCommand.trim();
    if (!command) {
      if (session.routedAt === null) {
        liveAssistLog("projects.not_configured", undefined, session.sessionId);
      }
      session.routedAt = Date.now();
      return;
    }
    session.routing = true;
    session.routedAt = Date.now();
    const startedAt = Date.now();
    try {
      session.context ??= loadCallContext(session.sessionId);
      const context = await session.context;
      const result = await routeCall(command, {
        call: { title: context.title, participants: context.participants },
        transcript: buildLiveAssistWindow(
          listenerStore.getState().liveSegments,
          0,
          Number.MAX_SAFE_INTEGER,
        ).text,
      });
      if (current !== session) {
        return;
      }
      session.projects = result.projects;
      const store = useLiveAssistStore.getState();
      store.setProjects(
        session.sessionId,
        result.projects.map(({ id, label }) => ({ id, title: label })),
      );
      if (result.projectId) {
        store.setAutoProject(session.sessionId, result.projectId);
      }
      liveAssistLog(
        "project.routed",
        {
          durationMs: Date.now() - startedAt,
          projectId: result.projectId,
          reason: result.reason,
          suggestions: result.projects.slice(0, 3).map(({ label }) => label),
          projects: result.projects.length,
        },
        session.sessionId,
      );
    } catch (error) {
      liveAssistLog(
        "project.route_failed",
        { durationMs: Date.now() - startedAt, error: describeError(error) },
        session.sessionId,
      );
      if (current === session && session.projects.length === 0) {
        useLiveAssistStore.getState().setProjectsFailed(session.sessionId);
      }
    } finally {
      session.routing = false;
    }
  };

  // Loaded once per project and kept for the whole call.
  const getProjectContext = (session: RunningSession, projectId: string) => {
    const cached = session.projectContexts.get(projectId);
    if (cached) {
      return cached;
    }
    const startedAt = Date.now();
    const loading = loadProjectContext(
      getConfig().projectsCommand.trim(),
      projectId,
    )
      .then((text) => {
        liveAssistLog(
          "project.context_loaded",
          {
            projectId,
            durationMs: Date.now() - startedAt,
            chars: text.length,
            text,
          },
          session.sessionId,
        );
        return text;
      })
      .catch((error) => {
        liveAssistLog(
          "project.context_failed",
          {
            projectId,
            durationMs: Date.now() - startedAt,
            error: describeError(error),
          },
          session.sessionId,
        );
        // Tried again with the next question.
        session.projectContexts.delete(projectId);
        return "";
      });
    session.projectContexts.set(projectId, loading);
    return loading;
  };

  const getProjectContextIfReady = async (
    session: RunningSession,
    projectId: string | null,
  ): Promise<string> => {
    if (!projectId) {
      return "";
    }
    const text = await Promise.race([
      getProjectContext(session, projectId),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), CONTEXT_WAIT_MS),
      ),
    ]);
    if (text === null) {
      liveAssistLog(
        "project.context_not_ready",
        { projectId },
        session.sessionId,
      );
      return "";
    }
    return text;
  };

  const getProjectName = (session: RunningSession, projectId: string | null) =>
    session.projects.find((project) => project.id === projectId)?.label ?? null;

  const tick = async () => {
    sync();
    const session = current;
    const config = getConfig();
    if (
      session &&
      !session.routing &&
      !getLiveAssistSession(session.sessionId).project.id &&
      session.routedAt !== null &&
      Date.now() - session.routedAt >= ROUTE_INTERVAL_MS
    ) {
      void route(session);
    }
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
      if (current !== session) {
        return;
      }
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
        participants: context.participants.map(({ name }) => name),
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
        // Short ids: the model echoes every id of the state on each update.
        newId: () => `i${(session.nextId += 1)}`,
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
        speaker: question.speaker,
      });
      liveAssistLog(
        "answer.question_detected",
        {
          question: question.text,
          turnEndedAtMs: question.endMs,
          latestAudioMs: listenerStore
            .getState()
            .liveSegments.reduce(
              (max, segment) => Math.max(max, segment.end_ms),
              0,
            ),
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
    const store = useLiveAssistStore.getState();
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

    const controller = new AbortController();
    session.answering = controller;
    store.updateAnswer(sessionId, next.id, { status: "answering" });
    const startedAt = Date.now();
    try {
      session.context ??= loadCallContext(sessionId);
      session.pastMeetings ??= loadPastMeetingsFor(session);
      const projectId = getLiveAssistSession(sessionId).project.id;
      const command = config.projectsCommand.trim();
      const segments = listenerStore.getState().liveSegments;
      const lastEndMs = segments.reduce(
        (max, segment) => Math.max(max, segment.end_ms),
        0,
      );
      const transcript = buildLiveAssistWindow(
        segments,
        lastEndMs - ANSWER_CONTEXT_MS + 120_000,
      ).text;
      const context = await session.context;
      const [pastMeetings, notes, language] = await Promise.all([
        session.pastMeetings,
        getProjectContextIfReady(session, projectId),
        resolveCallLanguage(config, transcript),
      ]);
      const projectRead =
        projectId && command
          ? (query: { section?: string; search?: string }) =>
              readProject(command, projectId, query).catch((error) => {
                liveAssistLog(
                  "answer.read_failed",
                  { id: next.id, query, error: describeError(error) },
                  sessionId,
                );
                return [];
              })
          : null;
      const webTools = config.webSearch
        ? getWebSearchTools(config.model)
        : null;
      const prompt = buildLiveAnswerPrompt({
        question: next.question,
        origin: next.origin,
        language,
        callTitle: context.title,
        transcript,
        speaker: next.speaker ?? null,
        projectName: getProjectName(session, projectId),
        notes,
        pastMeetings: pastMeetings.text,
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
          projectId,
          notesChars: notes.length,
          pastMeetingsChars: pastMeetings.text.length,
          waitedInQueueMs: startedAt - next.createdAtMs,
          promptChars: prompt.context.length + prompt.request.length,
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
        projectRead,
        signal: controller.signal,
        onText: (text) => {
          const now = Date.now();
          if (
            current !== session ||
            (text && now - lastRenderAt < ANSWER_RENDER_INTERVAL_MS)
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
          reads: result.reads,
        },
        sessionId,
      );
    } catch (error) {
      const interrupted = controller.signal.aborted;
      if (current === session) {
        if (interrupted) {
          store.removeAnswer(sessionId, next.id);
        } else {
          store.updateAnswer(sessionId, next.id, {
            status: "error",
            answer:
              next.origin === "asked"
                ? t`The AI model did not respond. Check your AI settings.`
                : "",
          });
        }
      }
      liveAssistLog(
        interrupted ? "answer.interrupted" : "answer.failed",
        {
          id: next.id,
          durationMs: Date.now() - startedAt,
          error: describeError(error),
        },
        sessionId,
      );
    } finally {
      session.answering = null;
      if (current === session) {
        void processAnswers(session);
      }
    }
  };

  const interval = setInterval(() => void tick(), TICK_MS);
  // Questions are looked for once the participants have been quiet for a
  // moment; the user starting to reply does not hold them back.
  const questionScan = setInterval(() => {
    const session = current;
    const now = Date.now();
    if (
      session &&
      session.transcriptSignature !== session.scannedSignature &&
      (now - session.transcriptChangedAt >= QUESTION_QUIET_MS ||
        now - session.scannedAt >= QUESTION_MAX_WAIT_MS)
    ) {
      session.scannedSignature = session.transcriptSignature;
      session.scannedAt = now;
      scanQuestions();
    }
  }, QUESTION_SCAN_MS);
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
      const signature = getTranscriptSignature(state.liveSegments);
      if (signature !== current.transcriptSignature) {
        current.transcriptSignature = signature;
        current.transcriptChangedAt = Date.now();
      }
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
    const project = state.sessions[sessionId]?.project;
    if (project && project !== previous.sessions[sessionId]?.project) {
      liveAssistLog(
        "project.changed",
        { ...project, name: getProjectName(session, project.id) },
        sessionId,
      );
      if (project.id) {
        void getProjectContext(session, project.id);
      } else {
        void route(session);
      }
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
      clearInterval(questionScan);
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
  const context: CallContext = {
    title: getEventName(snapshot?.event) ?? (snapshot?.title || null),
    participants: (snapshot?.participants ?? [])
      .filter((participant) => participant.name || participant.email)
      .map((participant) => ({
        name: participant.name,
        email: participant.email || null,
      })),
  };
  liveAssistLog("context.loaded", context, sessionId);
  return context;
}

function getTranscriptSignature(segments: LiveTranscriptSegment[]): string {
  let last: LiveTranscriptSegment | null = null;
  for (const segment of segments) {
    if (!last || segment.end_ms >= last.end_ms) last = segment;
  }
  return last
    ? `${segments.length}:${last.id}:${last.text.length}:${last.words.filter((word) => word.is_final).length}`
    : "";
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
