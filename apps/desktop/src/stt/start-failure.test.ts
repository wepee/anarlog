import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  classifyStartFailure,
  describeStartFailure,
  getMicrophonePermission,
} from "./start-failure";

const mocks = vi.hoisted(() => ({
  checkPermission: vi.fn(),
}));

vi.mock("@anlg/plugin-permissions", () => ({
  commands: { checkPermission: mocks.checkPermission },
}));

describe("getMicrophonePermission", () => {
  beforeEach(() => {
    mocks.checkPermission.mockReset();
    mocks.checkPermission.mockResolvedValue({ status: "ok", data: "denied" });
  });

  test("reports the macOS permission status", async () => {
    await expect(getMicrophonePermission()).resolves.toBe("denied");
  });
});

describe("classifyStartFailure", () => {
  test("treats a recovery-marker failure as storage", () => {
    expect(
      classifyStartFailure({
        stage: "recovery_marker",
        error: null,
        microphonePermission: null,
      }),
    ).toBe("storage");
  });

  test("recognizes native error messages", () => {
    expect(
      classifyStartFailure({
        stage: "capture_rejected",
        error: "session already running",
        microphonePermission: "denied",
      }),
    ).toBe("already_running");
    expect(
      classifyStartFailure({
        stage: "capture_rejected",
        error: "session storage unavailable",
        microphonePermission: "authorized",
      }),
    ).toBe("storage");
  });

  test("blames microphone permission only when it is not granted", () => {
    expect(
      classifyStartFailure({
        stage: "capture_rejected",
        error: "start session failed",
        microphonePermission: "denied",
      }),
    ).toBe("microphone_permission");
    expect(
      classifyStartFailure({
        stage: "capture_start",
        error: "start session failed",
        microphonePermission: "authorized",
      }),
    ).toBe("recorder");
  });

  test("offers the permissions page for a missing microphone grant", () => {
    expect(describeStartFailure("microphone_permission").action?.tab).toBe(
      "permissions",
    );
  });
});
