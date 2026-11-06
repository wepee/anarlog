import { beforeEach, describe, expect, it, vi } from "vitest";

import { md2json } from "@anlg/editor/markdown";

import {
  collectMeetingScreenContext,
  embedMeetingScreens,
  stripMeetingScreenImages,
} from "./enhance-screens";

const fsSyncMocks = vi.hoisted(() => ({
  attachmentList: vi.fn(),
  attachmentRead: vi.fn(),
}));

vi.mock("@anlg/plugin-fs-sync", () => ({ commands: fsSyncMocks }));
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost${path}`,
}));

const RECORDING_STARTED_AT = Date.parse("2026-11-06T10:00:00.000Z");

function screenRecord(attachmentId: string, capturedAt: string) {
  return {
    id: `session-1:meeting-screen:${attachmentId}`,
    attachmentId,
    platform: "zoom",
    width: 1920,
    height: 1080,
    capturedAt,
  };
}

describe("meeting screen summary context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsSyncMocks.attachmentList.mockResolvedValue({
      status: "ok",
      data: ["slide-a", "slide-b"].map((attachmentId) => ({
        attachmentId,
        path: `/vault/session-1/attachments/${attachmentId}.jpg`,
        extension: "jpg",
        modifiedAt: "",
      })),
    });
    fsSyncMocks.attachmentRead.mockResolvedValue({
      status: "ok",
      data: [255, 216, 255],
    });
  });

  it("labels each capture with its session ref and transcript time", async () => {
    const { images, screens } = await collectMeetingScreenContext({
      sessionId: "session-1",
      records: [
        screenRecord("slide-a", "2026-11-06T10:02:05.000Z"),
        screenRecord("missing", "2026-11-06T10:05:00.000Z"),
        screenRecord("slide-b", "2026-11-06T11:03:09.000Z"),
      ],
      recordingStartedAt: RECORDING_STARTED_AT,
    });

    expect(images.map((image) => image.label)).toEqual([
      "[S1] Zoom shared screen, appeared at [02:05] in the transcript:",
      "[S3] Zoom shared screen, appeared at [63:09] in the transcript:",
    ]);
    expect(screens).toEqual([
      {
        ref: "S1",
        attachmentId: "slide-a",
        src: "asset://localhost/vault/session-1/attachments/slide-a.jpg",
      },
      {
        ref: "S3",
        attachmentId: "slide-b",
        src: "asset://localhost/vault/session-1/attachments/slide-b.jpg",
      },
    ]);
  });

  it("turns screen references in the summary into attachment images", () => {
    const markdown = [
      "# Roadmap",
      "",
      "Revenue grew 20% in Q3.",
      "",
      "![Q3 revenue chart](screen:S3)",
      "",
      "![Invented slide](screen:S9)",
      "",
      "- Ship Friday",
    ].join("\n");

    const doc = embedMeetingScreens(md2json(markdown), [
      {
        ref: "S3",
        attachmentId: "slide-b",
        src: "asset://localhost/slide-b.jpg",
      },
    ]);
    const blocks = (doc as { content: Array<{ type: string; attrs?: object }> })
      .content;

    expect(blocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "image",
      "bulletList",
    ]);
    expect(blocks[2].attrs).toMatchObject({
      src: "asset://localhost/slide-b.jpg",
      attachmentId: "slide-b",
      alt: "Q3 revenue chart",
    });
  });

  it("hides screen references while the summary streams", () => {
    expect(
      stripMeetingScreenImages(
        "Revenue grew.\n\n![Q3 chart](screen:S3)\n\n![Next](screen:S",
      ),
    ).toBe("Revenue grew.\n\n\n\n");
  });
});
