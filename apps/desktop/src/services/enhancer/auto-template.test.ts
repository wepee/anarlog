import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  detectCallTemplate: vi.fn(),
}));

vi.mock("~/chat/context/session-context-hydrator", () => ({
  hydrateSessionContext: vi.fn(async () => ({
    title: "Point",
    event: null,
    participants: [],
    transcript: { segments: [{ speaker: "A", text: "bonjour" }] },
  })),
}));
vi.mock("~/templates/queries", () => ({
  listUserTemplates: vi.fn(async () => [
    { id: "sales", title: "Commercial", description: "", sections: [] },
  ]),
}));
vi.mock("~/session/live-assist/journal", () => ({
  liveAssistLog: vi.fn(),
  describeError: (error: unknown) => error,
}));
vi.mock("~/templates/detect", () => ({
  detectCallTemplate: mocks.detectCallTemplate,
}));

import { resolveAutoTemplateId } from "./auto-template";

const model = {} as never;

describe("resolveAutoTemplateId", () => {
  beforeEach(() => {
    mocks.detectCallTemplate.mockReset();
  });

  it("falls back to the default template without a proven detection", async () => {
    mocks.detectCallTemplate.mockResolvedValue({ templateId: null });

    await expect(
      resolveAutoTemplateId({
        sessionId: "unclear-session",
        model,
        defaultTemplateId: "default",
      }),
    ).resolves.toBe("default");
  });
});
