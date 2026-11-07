import { t } from "@lingui/core/macro";

import { getSourceLabel } from "~/session/live-assist/research";
import type { LiveAssistSessionState } from "~/store/zustand/live-assist";

// What the floating panel shows for Live Assist. It travels as a JSON string
// through the windows plugin to both the native macOS panel and the webview
// overlay, so its shape is the contract between them: keep the Swift
// `FloatingAssistPayload` in plugins/windows/swift-lib in sync.
export type FloatingAssist = {
  labels: {
    questions: string;
    todo: string;
    summary: string;
    live: string;
    lastMinutes: string;
    sinceStart: string;
    toCover: string;
    decisions: string;
    due: string;
    toClarify: string;
    dismiss: string;
    templateMenu: string;
    templateFooter: string;
    auto: string;
    emptyQuestions: string;
    emptyTodo: string;
    emptySummary: string;
    answers: string;
    askPlaceholder: string;
    answering: string;
    noAnswer: string;
    emptyAnswers: string;
    youAsked: string;
  };
  template: { id: string | null; title: string; auto: boolean };
  templates: Array<{ id: string | null; title: string }>;
  questions: Array<{
    id: string;
    text: string;
    why: string;
    isNew: boolean;
    source: { label: string; url: string } | null;
  }>;
  coverage: Array<{
    label: string;
    status: "covered" | "partial" | "missing";
    evidence: string | null;
  }>;
  todoGroups: Array<{
    owner: string;
    items: Array<{ text: string; due: string | null; needsDetail: boolean }>;
  }>;
  recent: string;
  decisions: string[];
  topics: Array<{
    start: string | null;
    title: string;
    live: boolean;
    bullets: string[];
  }>;
  newQuestions: number;
  answers: Array<{
    id: string;
    question: string;
    origin: "auto" | "asked";
    status: "queued" | "answering" | "ready" | "error";
    answer: string;
    sources: Array<{
      kind: "note" | "obsidian" | "web";
      label: string;
      url: string | null;
    }>;
    isNew: boolean;
  }>;
  newAnswers: number;
};

export type FloatingAssistAction =
  | { action: "dismissQuestion"; id: string }
  | { action: "selectTemplate"; id: string | null }
  | { action: "seenQuestions" }
  | { action: "ask"; id: string }
  | { action: "seenAnswers" };

const SELF_OWNERS = new Set(["you", "vous", "moi", "me"]);

export function buildFloatingAssist(
  session: LiveAssistSessionState,
): FloatingAssist {
  const { snapshot, template, templates } = session;
  const autoTitle = t`Auto`;
  const selfLabel = t`Me`;
  const noOwnerLabel = t`No owner`;

  const groups = new Map<string, FloatingAssist["todoGroups"][number]>();
  const groupFor = (owner: string) => {
    let group = groups.get(owner);
    if (!group) {
      group = { owner, items: [] };
      groups.set(owner, group);
    }
    return group;
  };
  groupFor(selfLabel);
  for (const todo of snapshot.todos) {
    const owner = todo.owner
      ? SELF_OWNERS.has(todo.owner.toLowerCase())
        ? selfLabel
        : todo.owner
      : noOwnerLabel;
    groupFor(owner).items.push({
      text: todo.text,
      due: todo.due,
      needsDetail: !todo.owner || !todo.due,
    });
  }
  const unassigned = groups.get(noOwnerLabel);
  groups.delete(noOwnerLabel);
  const todoGroups = [
    ...groups.values(),
    ...(unassigned ? [unassigned] : []),
  ].filter((group) => group.items.length > 0);

  const lastTopic = snapshot.topics[snapshot.topics.length - 1];

  return {
    labels: {
      questions: t`Questions`,
      todo: t`To-do`,
      summary: t`Summary`,
      live: t`Live`,
      lastMinutes: t`Last 2 min`,
      sinceStart: t`Since the start`,
      toCover: t`For the summary`,
      decisions: t`Decisions`,
      due: t`due`,
      toClarify: t`to clarify`,
      dismiss: t`Dismiss`,
      templateMenu: t`Summary template`,
      templateFooter: t`The summary after the call will use this template.`,
      auto: t`auto`,
      emptyQuestions: t`Questions to ask will show up once the conversation gets going.`,
      emptyTodo: t`No action items yet.`,
      emptySummary: t`The summary shows up after the first minute of conversation.`,
      answers: t`Answers`,
      askPlaceholder: t`Ask about this call…`,
      answering: t`Answering…`,
      noAnswer: t`No answer found.`,
      emptyAnswers: t`Questions asked to you get a suggested answer here. You can also ask your own.`,
      youAsked: t`You asked`,
    },
    template: {
      id: template.id,
      title:
        templates.find((option) => option.id === template.id)?.title ??
        autoTitle,
      auto: template.source === "auto",
    },
    templates: [
      { id: null, title: autoTitle },
      ...templates.map(({ id, title }) => ({ id, title })),
    ],
    questions: snapshot.questions.map(
      ({ id, text, why, isNew, sourceUrl }) => ({
        id,
        text,
        why,
        isNew,
        source: sourceUrl
          ? { label: getSourceLabel(sourceUrl), url: sourceUrl }
          : null,
      }),
    ),
    coverage: snapshot.coverage,
    todoGroups,
    recent: snapshot.recent,
    decisions: snapshot.decisions.map((decision) => decision.text),
    topics: snapshot.topics.map((topic) => ({
      start: topic.start,
      title: topic.title,
      live: topic === lastTopic && !topic.closed,
      bullets: topic.bullets,
    })),
    newQuestions: snapshot.questions.filter((question) => question.isNew)
      .length,
    answers: session.answers.map(
      ({ id, question, origin, status, answer, sources, isNew }) => ({
        id,
        question,
        origin,
        status,
        answer,
        sources,
        isNew,
      }),
    ),
    newAnswers: session.answers.filter(
      (answer) => answer.isNew && answer.status === "ready",
    ).length,
  };
}
