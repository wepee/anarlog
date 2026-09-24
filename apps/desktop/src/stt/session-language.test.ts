import { describe, expect, it, vi } from "vitest";

vi.mock("~/db", () => ({
  executeTransaction: vi.fn(),
  liveQueryClient: { execute: vi.fn() },
  useLiveQuery: vi.fn(),
}));

vi.mock("~/db/write-queue", () => ({ enqueueDatabaseWrite: vi.fn() }));

import { withSessionTranscriptLanguage } from "./session-language";

describe("withSessionTranscriptLanguage", () => {
  it("puts the note's language first so a single-locale provider uses it", () => {
    expect(withSessionTranscriptLanguage("en", ["fr", "en"])).toEqual([
      "en",
      "fr",
    ]);
  });

  it("keeps the configured languages when the note has no override", () => {
    expect(withSessionTranscriptLanguage("", ["fr", "en"])).toEqual([
      "fr",
      "en",
    ]);
    expect(withSessionTranscriptLanguage(null, ["fr"])).toEqual(["fr"]);
  });

  it("adds a language the settings do not list", () => {
    expect(withSessionTranscriptLanguage("de", ["fr", "en"])).toEqual([
      "de",
      "fr",
      "en",
    ]);
  });

  it("matches regional variants against their base language", () => {
    expect(withSessionTranscriptLanguage("en-US", ["fr", "en"])).toEqual([
      "en-US",
      "fr",
    ]);
  });
});
