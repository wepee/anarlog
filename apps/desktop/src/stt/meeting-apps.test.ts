import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveFaviconPath: vi.fn(),
}));

vi.mock("@anlg/plugin-notification", () => ({
  commands: { resolveFaviconPath: mocks.resolveFaviconPath },
}));

import {
  getBrowserMeetingPlatform,
  getFaviconIconForUrl,
  getMeetingPlatformNameForMicApp,
} from "./meeting-apps";

describe("meeting app platform names", () => {
  it("only promotes explicitly classified meeting apps", () => {
    expect(getMeetingPlatformNameForMicApp({ id: "zoom", name: "Zoom" })).toBe(
      "Zoom",
    );
    expect(
      getMeetingPlatformNameForMicApp({
        id: "com.apple.FaceTime",
        name: "FaceTime",
      }),
    ).toBeNull();
  });

  it("detects X Calls for a browser mic app with an X call link", () => {
    const chrome = { id: "com.google.Chrome", name: "Google Chrome" };

    expect(
      getBrowserMeetingPlatform([chrome], {
        id: "event-1",
        title: "Call",
        meetingLink: "https://call.x.com/1A2b3C4d5E",
        participantNames: [],
      })?.displayName,
    ).toBe("X Calls");

    expect(
      getBrowserMeetingPlatform([chrome], {
        id: "event-2",
        title: "Call",
        location: "https://x.com/anarlog",
        participantNames: [],
      }),
    ).toBeNull();
  });
});

describe("getFaviconIconForUrl", () => {
  it("resolves a path icon for the page's hostname", async () => {
    mocks.resolveFaviconPath.mockResolvedValue({
      status: "ok",
      data: "/cache/favicons/meet.google.com.png",
    });

    const icon = await getFaviconIconForUrl(
      "https://meet.google.com/abc-defg-hij",
    );

    expect(mocks.resolveFaviconPath).toHaveBeenCalledWith("meet.google.com");
    expect(icon).toEqual({
      type: "path",
      path: "/cache/favicons/meet.google.com.png",
    });
  });

  it("returns null when the favicon command fails", async () => {
    mocks.resolveFaviconPath.mockResolvedValue({
      status: "error",
      error: "favicon request failed",
    });

    expect(
      await getFaviconIconForUrl("https://meet.google.com/abc-defg-hij"),
    ).toBeNull();
  });

  it("returns null for an unparsable URL", async () => {
    expect(await getFaviconIconForUrl("not-a-url")).toBeNull();
    expect(mocks.resolveFaviconPath).not.toHaveBeenCalled();
  });
});
