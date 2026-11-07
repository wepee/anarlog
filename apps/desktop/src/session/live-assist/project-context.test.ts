import { describe, expect, it } from "vitest";

import { getProjectTerms, selectProjectNotes } from "./project-context";

function file(path: string, content: string, modifiedMs = 0) {
  return { path, content, modifiedMs };
}

describe("selectProjectNotes", () => {
  it("keeps the notes about the call's project and ignores terms found everywhere", () => {
    const terms = getProjectTerms("Point Acme / Avicenne", [
      "Adam Martin",
      "Léa Durand",
    ]);
    const files = [
      file("Projets/Acme/Contexte.md", "Client Acme. Contact : Léa Durand."),
      file("Projets/Acme/Devis.md", "Devis Acme v2"),
      file("Projets/Globex.md", "Avicenne pour Globex"),
      file("Journal/2026-10-01.md", "Avicenne, Adam Martin"),
      file("Journal/2026-10-02.md", "Avicenne, Adam Martin"),
      file("Journal/2026-10-03.md", "Avicenne, Adam Martin"),
      file("Recettes/Pain.md", "Farine, eau, sel"),
      file("Lectures/Livres.md", "À lire"),
      file("Idées.md", "Une app de notes"),
    ];

    const selected = selectProjectNotes(files, terms);

    expect(selected.map((note) => note.path)).toEqual([
      "Projets/Acme/Contexte.md",
      "Projets/Acme/Devis.md",
    ]);
  });
});
