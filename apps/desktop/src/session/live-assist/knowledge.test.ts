import { describe, expect, it } from "vitest";

import { searchMarkdownFiles } from "./knowledge";

const file = (path: string, content: string, modifiedMs = 0) => ({
  path,
  content,
  modifiedMs,
});

describe("searchMarkdownFiles", () => {
  it("ranks the vault notes that match the question, accents aside", () => {
    const results = searchMarkdownFiles(
      [
        file("Recettes/Tarte.md", "Farine, beurre, sucre."),
        file(
          "Offres/Audit IA.md",
          "Tarif de l'audit : 4 500 € HT, livré en 3 semaines.",
        ),
        file(
          "Clients/Opticonnect.md",
          "Démo prévue, tarif distributeur à négocier.",
        ),
      ],
      "Quel est le tarif de votre audit ?",
    );

    expect(results.map((result) => result.title)).toEqual(["Offres/Audit IA"]);
    expect(results[0]?.tag).toBe("O1");
    expect(results[0]?.excerpt).toContain("4 500 €");
  });
});
