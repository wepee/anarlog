import { describe, expect, it } from "vitest";

import {
  explainTemplateProposal,
  formatTemplateCandidates,
  isEvidenceInTranscript,
} from "./detect";

const candidates = [
  { id: "sales", title: "Commercial", description: "", sections: [] },
  { id: "team", title: "Équipe", description: "", sections: [] },
];

const transcript = [
  "Vous: Bonjour, vous m'entendez ?",
  "Speaker 1: Oui. Alors on cherche un outil pour gérer nos devis, c'est vraiment notre priorité.",
].join("\n");

describe("explainTemplateProposal", () => {
  it("applies a template backed by a sentence that was said", () => {
    expect(
      explainTemplateProposal(
        {
          templateId: "sales",
          confidence: "high",
          evidence: "on cherche un outil pour gérer nos devis",
        },
        candidates,
        transcript,
      ).templateId,
    ).toBe("sales");
  });

  it("ignores a proposal whose quote was never said", () => {
    expect(
      explainTemplateProposal(
        {
          templateId: "team",
          confidence: "high",
          evidence: "on répartit les tâches de la semaine",
        },
        candidates,
        transcript,
      ).templateId,
    ).toBeNull();
  });

  it("ignores medium confidence and unknown templates", () => {
    const evidence = "on cherche un outil pour gérer nos devis";
    expect(
      explainTemplateProposal(
        { templateId: "sales", confidence: "medium", evidence },
        candidates,
        transcript,
      ).templateId,
    ).toBeNull();
    expect(
      explainTemplateProposal(
        { templateId: "deleted", confidence: "high", evidence },
        candidates,
        transcript,
      ).templateId,
    ).toBeNull();
  });
});

describe("isEvidenceInTranscript", () => {
  it("rejects quotes too short to prove anything", () => {
    expect(isEvidenceInTranscript("oui", transcript)).toBe(false);
  });
});

describe("formatTemplateCandidates", () => {
  it("gives the detector what the user wrote on a custom template", () => {
    const text = formatTemplateCandidates([
      {
        id: "board",
        title: "Comité de pilotage",
        description:
          "Point mensuel avec le client sur le budget et le planning",
        sections: ["Risques"],
        sectionDescriptions: [
          "{% if x %}Risques ouverts et parades{% endif %}",
        ],
        targets: ["client", "mensuel"],
      },
    ]);

    expect(text).toContain(
      "when: Point mensuel avec le client sur le budget et le planning",
    );
    expect(text).toContain("tags: client, mensuel");
    expect(text).toContain("sections: Risques (Risques ouverts et parades)");
  });
});
