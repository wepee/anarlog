import { describe, expect, it } from "vitest";

import { buildFloatingAssist } from "./assist";

import { EMPTY_LIVE_ASSIST_SNAPSHOT } from "~/session/insights/live-assist";

describe("buildFloatingAssist", () => {
  it("groups action items by owner and flags the ones to clarify", () => {
    const assist = buildFloatingAssist({
      templates: [{ id: "sales", title: "Commercial" }],
      answers: [],
      projects: [],
      projectsFailed: false,
      project: { id: null, source: "auto" },
      snapshot: {
        ...EMPTY_LIVE_ASSIST_SNAPSHOT,
        todos: [
          { id: "1", text: "Plan the workshop", owner: null, due: null },
          { id: "2", text: "Send the quote", owner: "You", due: "Friday" },
          { id: "3", text: "Share the export", owner: "Claire", due: null },
        ],
      },
      template: { id: "sales", source: "auto" },
      dismissed: [],
      updatedAtMs: 1,
      status: "idle",
    });

    expect(assist.todoGroups).toEqual([
      {
        owner: "Me",
        items: [{ text: "Send the quote", due: "Friday", needsDetail: false }],
      },
      {
        owner: "Claire",
        items: [{ text: "Share the export", due: null, needsDetail: true }],
      },
      {
        owner: "No owner",
        items: [{ text: "Plan the workshop", due: null, needsDetail: true }],
      },
    ]);
    expect(assist.template).toEqual({
      id: "sales",
      title: "Commercial",
      auto: true,
    });
    expect(assist.templates[0]).toEqual({ id: null, title: "Auto" });
  });

  it("hides answers to detected questions until their text starts", () => {
    const answer = {
      sources: [],
      isNew: true,
      createdAtMs: 1,
    };
    const assist = buildFloatingAssist({
      templates: [],
      projects: [],
      projectsFailed: false,
      project: { id: null, source: "auto" },
      answers: [
        {
          ...answer,
          id: "a",
          question: "Tu m'entends ?",
          origin: "auto",
          status: "answering",
          answer: "",
        },
        {
          ...answer,
          id: "b",
          question: "Quel délai ?",
          origin: "auto",
          status: "answering",
          answer: "Trois semaines",
        },
        {
          ...answer,
          id: "c",
          question: "Prix ?",
          origin: "asked",
          status: "queued",
          answer: "",
        },
      ],
      snapshot: EMPTY_LIVE_ASSIST_SNAPSHOT,
      template: { id: null, source: "auto" },
      dismissed: [],
      updatedAtMs: 1,
      status: "idle",
    });

    expect(assist.answers.map((item) => item.id)).toEqual(["b", "c"]);
  });
});
