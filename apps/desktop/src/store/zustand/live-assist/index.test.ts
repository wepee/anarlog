import { beforeEach, describe, expect, it } from "vitest";

import { getLiveAssistSession, useLiveAssistStore } from ".";

import { EMPTY_LIVE_ASSIST_SNAPSHOT } from "~/session/insights/live-assist";

const question = (id: string, text: string) => ({
  id,
  text,
  why: "why",
  isNew: true,
});

describe("live assist store", () => {
  beforeEach(() => {
    useLiveAssistStore.setState({ sessions: {} });
  });

  it("keeps a dismissed question out of later updates", () => {
    const store = useLiveAssistStore.getState();
    store.applyUpdate("s1", {
      snapshot: {
        ...EMPTY_LIVE_ASSIST_SNAPSHOT,
        questions: [question("q1", "Qui décide ?")],
      },
      template: { id: null, source: "auto" },
      updatedAtMs: 1,
    });
    store.dismissQuestion("s1", "q1");
    store.applyUpdate("s1", {
      snapshot: {
        ...EMPTY_LIVE_ASSIST_SNAPSHOT,
        questions: [question("q2", "Qui décide ?")],
      },
      template: { id: null, source: "auto" },
      updatedAtMs: 2,
    });

    expect(getLiveAssistSession("s1").snapshot.questions).toEqual([]);
  });

  it("does not let an update override a template picked by hand", () => {
    const store = useLiveAssistStore.getState();
    store.selectTemplate("s1", "team");
    store.applyUpdate("s1", {
      snapshot: EMPTY_LIVE_ASSIST_SNAPSHOT,
      template: { id: "sales", source: "auto" },
      updatedAtMs: 1,
    });

    expect(getLiveAssistSession("s1").template).toEqual({
      id: "team",
      source: "manual",
    });
  });

  it("never lets an automatic project replace one picked by hand", () => {
    const store = useLiveAssistStore.getState();
    store.selectProject("s1", null);
    store.setAutoProject("s1", "lumen");
    expect(getLiveAssistSession("s1").project).toEqual({
      id: null,
      source: "manual",
    });

    store.resetProject("s1");
    store.setAutoProject("s1", "lumen");
    expect(getLiveAssistSession("s1").project).toEqual({
      id: "lumen",
      source: "auto",
    });
  });
});
