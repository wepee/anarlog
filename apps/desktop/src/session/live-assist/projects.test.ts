import { describe, expect, it } from "vitest";

import { parseContext, parsePassages, parseProjects } from "./projects";

// Real outputs of the user's command (Memex `anarlog`), anonymized.
const projectsOutput = [
  { id: "projects/Studio/lumen-optique", label: "lumen-optique" },
  { id: "🤖 Agence/Agence", label: "Agence" },
  { id: "projects/old-projects/vieux-client", label: "vieux-client" },
];

const readOutput = {
  passages: [
    {
      ref: "[[projects/Studio/globex/MEMORY.md#Abonnement|MEMORY › Abonnement]]",
      text: "- **Le tarif Magasin passe à 79 €/mois HT en offre de lancement** ✓ 2026-07-31",
    },
    {
      ref: "[[projects/Studio/globex/sources/2026-10-01 Tiers payant [3290cd87].md#Transcript|2026-10-01 Tiers payant [3290cd87] › Transcript]]",
      text: "pouvoir chercher les prix pratiqués par la mutuelle du client…",
    },
  ],
};

describe("project command outputs", () => {
  it("keeps the command's order and ids as given", () => {
    expect(parseProjects([...projectsOutput, { id: "broken" }])).toEqual(
      projectsOutput,
    );
  });

  it("reads the context and the passages", () => {
    expect(
      parseContext({
        text: "# lumen-optique\n\n## Ce que c'est [[projects/Studio/lumen-optique/PROJECT.md#What this is|PROJECT › What this is]]",
      }),
    ).toContain("# lumen-optique");
    expect(parseContext({})).toBe("");
    expect(parsePassages(readOutput)).toEqual(readOutput.passages);
  });
});
