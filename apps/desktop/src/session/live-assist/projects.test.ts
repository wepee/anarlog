import { describe, expect, it } from "vitest";

import {
  parseContext,
  parsePassages,
  parseRouteResult,
  routeTranscript,
} from "./projects";

// Shaped like the contract's examples; to be replaced by real, anonymized
// outputs of the user's command once it exists.
const route = {
  projectId: "projects/lumen-optique",
  reason: "email",
  projects: [
    { id: "projects/lumen-optique", label: "Lumen Optique", icon: "👓" },
    { id: "projects/globex", label: "Globex" },
    { id: "broken" },
  ],
};

describe("project command outputs", () => {
  it("keeps a routed project only if it is in the list", () => {
    expect(parseRouteResult(route)).toEqual({
      projectId: "projects/lumen-optique",
      reason: "email",
      projects: [
        { id: "projects/lumen-optique", label: "Lumen Optique" },
        { id: "projects/globex", label: "Globex" },
      ],
    });
    expect(
      parseRouteResult({ ...route, projectId: "projects/unknown" }).projectId,
    ).toBeNull();
  });

  it("reads the context and the passages, ignoring malformed entries", () => {
    expect(parseContext({ text: "## Lumen Optique" })).toBe("## Lumen Optique");
    expect(parseContext({})).toBe("");
    expect(
      parsePassages({
        passages: [
          {
            ref: "[[projects/lumen-optique/MEMORY.md#Tarification|MEMORY › Tarification]]",
            text: "TJM 600 € HT",
          },
          { ref: "[[x]]" },
        ],
      }),
    ).toEqual([
      {
        ref: "[[projects/lumen-optique/MEMORY.md#Tarification|MEMORY › Tarification]]",
        text: "TJM 600 € HT",
      },
    ]);
  });

  it("keeps the start and the end of a long call for routing", () => {
    const transcript = `${"a".repeat(30_000)}${"b".repeat(30_000)}`;
    const sent = routeTranscript(transcript);

    expect(sent.length).toBeLessThanOrEqual(40_003);
    expect(sent.startsWith("a")).toBe(true);
    expect(sent.endsWith("b")).toBe(true);
  });
});
