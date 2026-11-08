import { describe, expect, it } from "vitest";

import { parseContext, parsePassages, parseProjects } from "./projects";

// Shaped like the contract's examples; to be replaced by real, anonymized
// outputs of the user's command once it exists.
describe("project command outputs", () => {
  it("keeps projects with an id and a label, in the command's order", () => {
    expect(
      parseProjects([
        { id: "projects/lumen-optique", label: "Lumen Optique", icon: "👓" },
        { id: "broken" },
        { id: "projects/globex", label: "Globex" },
      ]),
    ).toEqual([
      { id: "projects/lumen-optique", label: "Lumen Optique" },
      { id: "projects/globex", label: "Globex" },
    ]);
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
});
