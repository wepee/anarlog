import { describe, expect, it } from "vitest";

import { parseLiveAnswer } from "./answers";

const snippets = [
  {
    tag: "N1",
    kind: "note" as const,
    title: "Point Maison Lumen",
    excerpt: "",
  },
  {
    tag: "O1",
    kind: "obsidian" as const,
    title: "Offres/Audit IA",
    excerpt: "",
  },
];

describe("parseLiveAnswer", () => {
  it("keeps the answer readable and turns tags into sources", () => {
    const result = parseLiveAnswer(
      "L'audit coûte 4 500 € HT [O1], livré en trois semaines [O1].",
      snippets,
      [],
    );

    expect(result).toEqual({
      status: "ready",
      answer: "L'audit coûte 4 500 € HT, livré en trois semaines.",
      sources: [{ kind: "obsidian", label: "Offres/Audit IA", url: null }],
    });
  });

  it("drops questions the model chose not to answer", () => {
    expect(parseLiveAnswer("SKIP", snippets, []).status).toBe("skipped");
  });
});
