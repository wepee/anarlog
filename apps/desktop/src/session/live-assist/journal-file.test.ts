import { describe, expect, it, vi } from "vitest";

const appended = vi.hoisted(() => [] as string[]);

vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "1.2.3" }));
vi.mock("@tauri-apps/api/path", () => ({
  join: async (...parts: string[]) => parts.join("/"),
  downloadDir: async () => "/downloads",
}));
vi.mock("@anlg/plugin-tracing", () => ({
  commands: { logsDir: async () => ({ status: "ok", data: "/logs" }) },
}));
vi.mock("@anlg/plugin-fs2", () => ({
  commands: {
    appendTextFile: async (_path: string, content: string) => {
      appended.push(content);
      return { status: "ok", data: null };
    },
  },
}));

import { liveAssistLog } from "./journal";

describe("Live Assist journal file", () => {
  it("appends only the new entries", async () => {
    vi.useFakeTimers();
    liveAssistLog("first");
    liveAssistLog("second");
    await vi.advanceTimersByTimeAsync(3_000);
    liveAssistLog("third");
    await vi.advanceTimersByTimeAsync(3_000);
    vi.useRealTimers();

    expect(appended).toHaveLength(2);
    expect(appended[0]).toMatch(/first[\s\S]*second/);
    expect(appended[1]).not.toMatch(/first|second|Live Assist journal/);
    expect(appended[1]).toContain("third");
  });
});
