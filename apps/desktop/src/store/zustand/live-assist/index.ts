import { create } from "zustand";

import {
  EMPTY_LIVE_ASSIST_SNAPSHOT,
  type LiveAssistSnapshot,
  type LiveAssistTemplate,
} from "~/session/insights/live-assist";
import type { LiveAnswerSource } from "~/session/live-assist/answers";

export type LiveAssistTemplateOption = { id: string; title: string };

export type LiveAssistAnswer = {
  id: string;
  question: string;
  origin: "auto" | "asked";
  status: "queued" | "answering" | "ready" | "error";
  answer: string;
  sources: LiveAnswerSource[];
  isNew: boolean;
  createdAtMs: number;
};

const MAX_ANSWERS = 20;

export type LiveAssistSessionState = {
  templates: LiveAssistTemplateOption[];
  answers: LiveAssistAnswer[];
  snapshot: LiveAssistSnapshot;
  template: LiveAssistTemplate;
  dismissed: string[];
  updatedAtMs: number | null;
  status: "idle" | "updating" | "error";
};

const EMPTY_SESSION: LiveAssistSessionState = {
  templates: [],
  answers: [],
  snapshot: EMPTY_LIVE_ASSIST_SNAPSHOT,
  template: { id: null, source: "auto" },
  dismissed: [],
  updatedAtMs: null,
  status: "idle",
};

type LiveAssistState = {
  sessions: Record<string, LiveAssistSessionState>;
};

type LiveAssistActions = {
  setStatus: (
    sessionId: string,
    status: LiveAssistSessionState["status"],
  ) => void;
  setTemplates: (
    sessionId: string,
    templates: LiveAssistTemplateOption[],
  ) => void;
  queueAnswer: (
    sessionId: string,
    answer: Pick<LiveAssistAnswer, "id" | "question" | "origin">,
  ) => void;
  updateAnswer: (
    sessionId: string,
    answerId: string,
    patch: Partial<Pick<LiveAssistAnswer, "status" | "answer" | "sources">>,
  ) => void;
  removeAnswer: (sessionId: string, answerId: string) => void;
  markAnswersSeen: (sessionId: string) => void;
  applyUpdate: (
    sessionId: string,
    update: {
      snapshot: LiveAssistSnapshot;
      template: LiveAssistTemplate;
      updatedAtMs: number;
    },
  ) => void;
  dismissQuestion: (sessionId: string, questionId: string) => void;
  selectTemplate: (sessionId: string, templateId: string | null) => void;
  markQuestionsSeen: (sessionId: string) => void;
  clearSession: (sessionId: string) => void;
};

export const useLiveAssistStore = create<LiveAssistState & LiveAssistActions>(
  (set) => {
    const updateSession = (
      sessionId: string,
      update: (session: LiveAssistSessionState) => LiveAssistSessionState,
    ) =>
      set((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: update(state.sessions[sessionId] ?? EMPTY_SESSION),
        },
      }));

    return {
      sessions: {},
      setStatus: (sessionId, status) =>
        updateSession(sessionId, (session) => ({ ...session, status })),
      setTemplates: (sessionId, templates) =>
        updateSession(sessionId, (session) => ({ ...session, templates })),
      queueAnswer: (sessionId, answer) =>
        updateSession(sessionId, (session) => ({
          ...session,
          answers: [
            {
              ...answer,
              status: "queued" as const,
              answer: "",
              sources: [],
              isNew: answer.origin === "auto",
              createdAtMs: Date.now(),
            },
            ...session.answers,
          ].slice(0, MAX_ANSWERS),
        })),
      updateAnswer: (sessionId, answerId, patch) =>
        updateSession(sessionId, (session) => ({
          ...session,
          answers: session.answers.map((answer) =>
            answer.id === answerId ? { ...answer, ...patch } : answer,
          ),
        })),
      removeAnswer: (sessionId, answerId) =>
        updateSession(sessionId, (session) => ({
          ...session,
          answers: session.answers.filter((answer) => answer.id !== answerId),
        })),
      markAnswersSeen: (sessionId) =>
        updateSession(sessionId, (session) =>
          session.answers.some((answer) => answer.isNew)
            ? {
                ...session,
                answers: session.answers.map((answer) => ({
                  ...answer,
                  isNew: false,
                })),
              }
            : session,
        ),
      applyUpdate: (sessionId, { snapshot, template, updatedAtMs }) =>
        updateSession(sessionId, (session) => ({
          ...session,
          snapshot: {
            ...snapshot,
            questions: snapshot.questions.filter(
              (question) => !session.dismissed.includes(question.text),
            ),
          },
          // A choice made by hand while this update was running wins.
          template:
            session.template.source === "manual" ? session.template : template,
          updatedAtMs,
          status: "idle",
        })),
      dismissQuestion: (sessionId, questionId) =>
        updateSession(sessionId, (session) => {
          const question = session.snapshot.questions.find(
            (item) => item.id === questionId,
          );
          if (!question) {
            return session;
          }
          return {
            ...session,
            dismissed: [...session.dismissed, question.text],
            snapshot: {
              ...session.snapshot,
              questions: session.snapshot.questions.filter(
                (item) => item.id !== questionId,
              ),
            },
          };
        }),
      selectTemplate: (sessionId, templateId) =>
        updateSession(sessionId, (session) => ({
          ...session,
          template: { id: templateId, source: "manual" },
        })),
      markQuestionsSeen: (sessionId) =>
        updateSession(sessionId, (session) =>
          session.snapshot.questions.some((question) => question.isNew)
            ? {
                ...session,
                snapshot: {
                  ...session.snapshot,
                  questions: session.snapshot.questions.map((question) => ({
                    ...question,
                    isNew: false,
                  })),
                },
              }
            : session,
        ),
      clearSession: (sessionId) =>
        set((state) => {
          if (!(sessionId in state.sessions)) {
            return state;
          }
          const { [sessionId]: _removed, ...rest } = state.sessions;
          return { sessions: rest };
        }),
    };
  },
);

export function getLiveAssistSession(
  sessionId: string,
): LiveAssistSessionState {
  return useLiveAssistStore.getState().sessions[sessionId] ?? EMPTY_SESSION;
}
