import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "1.2.3" }));
vi.mock("@anlg/plugin-tracing", () => ({
  commands: { logsDir: async () => ({ status: "error", error: "none" }) },
}));

import {
  formatLiveAssistJournal,
  liveAssistLog,
  resetLiveAssistJournalForTests,
} from "./journal";

describe("Live Assist journal", () => {
  beforeEach(() => {
    resetLiveAssistJournalForTests();
  });

  it("exports every event with its session and data", async () => {
    liveAssistLog(
      "update.done",
      { update: 2, questions: ["Qui décide ?"] },
      "s1",
    );

    const text = await formatLiveAssistJournal();

    expect(text).toContain("App version: 1.2.3");
    expect(text).toMatch(/\[s1\] update\.done/);
    expect(text).toContain('"Qui décide ?"');
  });
});
