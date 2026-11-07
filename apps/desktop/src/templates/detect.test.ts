import { describe, expect, it } from "vitest";

import { acceptTemplateProposal, isEvidenceInTranscript } from "./detect";

const candidates = [
  { id: "sales", title: "Commercial", description: "", sections: [] },
  { id: "team", title: "Équipe", description: "", sections: [] },
];

const transcript = [
  "Vous: Bonjour, vous m'entendez ?",
  "Speaker 1: Oui. Alors on cherche un outil pour gérer nos devis, c'est vraiment notre priorité.",
].join("\n");

describe("acceptTemplateProposal", () => {
  it("applies a template backed by a sentence that was said", () => {
    expect(
      acceptTemplateProposal(
        {
          templateId: "sales",
          confidence: "high",
          evidence: "on cherche un outil pour gérer nos devis",
        },
        candidates,
        transcript,
      ),
    ).toBe("sales");
  });

  it("ignores a proposal whose quote was never said", () => {
    expect(
      acceptTemplateProposal(
        {
          templateId: "team",
          confidence: "high",
          evidence: "on répartit les tâches de la semaine",
        },
        candidates,
        transcript,
      ),
    ).toBeNull();
  });

  it("ignores medium confidence and unknown templates", () => {
    const evidence = "on cherche un outil pour gérer nos devis";
    expect(
      acceptTemplateProposal(
        { templateId: "sales", confidence: "medium", evidence },
        candidates,
        transcript,
      ),
    ).toBeNull();
    expect(
      acceptTemplateProposal(
        { templateId: "deleted", confidence: "high", evidence },
        candidates,
        transcript,
      ),
    ).toBeNull();
  });
});

describe("isEvidenceInTranscript", () => {
  it("rejects quotes too short to prove anything", () => {
    expect(isEvidenceInTranscript("oui", transcript)).toBe(false);
  });
});
