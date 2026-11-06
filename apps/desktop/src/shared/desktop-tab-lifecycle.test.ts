import { describe, expect, it, vi } from "vitest";

import { initializeDesktopTabs } from "./desktop-tab-lifecycle";

import { createSessionTab } from "~/store/zustand/tabs/test-utils";

describe("desktop tab lifecycle", () => {
  describe("initializeDesktopTabs", () => {
    it("restores pinned tabs and recent notes without opening a startup tab", async () => {
      const tabs = [createSessionTab({ id: "restored-session" })];
      const setRecentlyOpenedSessionIds = vi.fn();
      const restorePinnedTabs = vi.fn().mockResolvedValue(undefined);
      const restoreRecentlyOpenedSessionIds = vi
        .fn()
        .mockImplementation(async (set: (ids: string[]) => void) => {
          set(["restored-session"]);
        });

      await initializeDesktopTabs({
        getTabs: () => tabs,
        setRecentlyOpenedSessionIds,
        restorePinnedTabs,
        restoreRecentlyOpenedSessionIds,
        onZeroTabs: null,
        isTauriEnv: true,
      });

      expect(restorePinnedTabs).toHaveBeenCalledTimes(1);
      expect(setRecentlyOpenedSessionIds).toHaveBeenCalledWith([
        "restored-session",
      ]);
    });

    it("calls onZeroTabs when startup has no restored tabs", async () => {
      const onZeroTabs = vi.fn();

      await initializeDesktopTabs({
        getTabs: () => [],
        setRecentlyOpenedSessionIds: vi.fn(),
        restorePinnedTabs: vi.fn().mockResolvedValue(undefined),
        restoreRecentlyOpenedSessionIds: vi.fn().mockResolvedValue(undefined),
        onZeroTabs,
        isTauriEnv: true,
      });

      expect(onZeroTabs).toHaveBeenCalledTimes(1);
    });

    it("runs startup work even when pinned tabs were restored", async () => {
      const tabs = [createSessionTab({ id: "restored-session" })];
      const onInitialized = vi.fn();
      const onZeroTabs = vi.fn();

      await initializeDesktopTabs({
        getTabs: () => tabs,
        setRecentlyOpenedSessionIds: vi.fn(),
        restorePinnedTabs: vi.fn().mockResolvedValue(undefined),
        restoreRecentlyOpenedSessionIds: vi.fn().mockResolvedValue(undefined),
        onInitialized,
        onZeroTabs,
        isTauriEnv: true,
      });

      expect(onInitialized).toHaveBeenCalledTimes(1);
      expect(onZeroTabs).not.toHaveBeenCalled();
    });
  });
});
