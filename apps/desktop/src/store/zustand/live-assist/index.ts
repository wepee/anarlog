import { create } from "zustand";

import {
  EMPTY_LIVE_ASSIST_SNAPSHOT,
  type LiveAssistSnapshot,
  type LiveAssistTemplate,
} from "~/session/insights/live-assist";

export type LiveAssistTemplateOption = { id: string; title: string };

export type LiveAssistSessionState = {
  templates: LiveAssistTemplateOption[];
  snapshot: LiveAssistSnapshot;
  template: LiveAssistTemplate;
  dismissed: string[];
  updatedAtMs: number | null;
  status: "idle" | "updating" | "error";
};

const EMPTY_SESSION: LiveAssistSessionState = {
  templates: [],
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
