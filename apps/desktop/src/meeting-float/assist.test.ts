import { describe, expect, it } from "vitest";

import { buildFloatingAssist } from "./assist";

import { EMPTY_LIVE_ASSIST_SNAPSHOT } from "~/session/insights/live-assist";

describe("buildFloatingAssist", () => {
  it("groups action items by owner and flags the ones to clarify", () => {
    const assist = buildFloatingAssist({
      templates: [{ id: "sales", title: "Commercial" }],
      research: [],
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
});
