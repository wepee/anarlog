import { describe, expect, it } from "vitest";

import {
  appIconAssetName,
  normalizeAppIconPreference,
  resolveAppIconName,
  resolveDockIconName,
} from "./icon";

describe("app icon preference", () => {
  it("falls back to the default icon for unknown values", () => {
    expect(normalizeAppIconPreference(undefined)).toBe("default");
    expect(normalizeAppIconPreference("unknown")).toBe("default");
    expect(normalizeAppIconPreference("dev")).toBe("dev");
    expect(normalizeAppIconPreference("staging")).toBe("staging");
    expect(normalizeAppIconPreference("journal")).toBe("journal");
    expect(normalizeAppIconPreference("notepad")).toBe("notepad");
    expect(normalizeAppIconPreference("stone")).toBe("stone");
    expect(normalizeAppIconPreference("typewriter-key")).toBe("typewriter-key");
    expect(normalizeAppIconPreference("walnut")).toBe("walnut");
  });

  it("resolves the default icon from the app channel", () => {
    expect(resolveAppIconName("default", "com.hyprnote.stable")).toBe("stable");
    expect(resolveAppIconName("default", "com.hyprnote.nightly")).toBe(
      "staging",
    );
    expect(resolveAppIconName("default", "com.hyprnote.staging")).toBe(
      "staging",
    );
    expect(resolveAppIconName("default", "com.hyprnote.dev")).toBe("dev");
  });

  it("keeps the same icon whatever the system appearance is", () => {
    expect(resolveDockIconName("anagram", "com.hyprnote.dev")).toBe("anagram");
    expect(resolveDockIconName("staging", "com.hyprnote.stable")).toBe(
      "staging",
    );
    expect(resolveDockIconName("journal", "com.hyprnote.stable")).toBe(
      "journal",
    );
  });

  it("ships the dark artwork as the stable icon", () => {
    expect(resolveDockIconName("default", "com.hyprnote.stable")).toBe(
      "stable-dark",
    );
    expect(resolveDockIconName("stable", "com.hyprnote.dev")).toBe(
      "stable-dark",
    );
  });

  it("names the preview file of each icon", () => {
    expect(appIconAssetName("stable")).toBe("stable-dark");
    expect(appIconAssetName("anagram")).toBe("anagram-light");
    expect(appIconAssetName("walnut")).toBe("walnut");
  });
});
