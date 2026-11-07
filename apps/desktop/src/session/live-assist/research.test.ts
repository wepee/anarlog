import { describe, expect, it } from "vitest";

import { normalizeResearchQuery } from "./research";

describe("normalizeResearchQuery", () => {
  it("only lets a name leave for the search engine", () => {
    expect(normalizeResearchQuery(" « Shopify Plus » ")).toBe("Shopify Plus");
    expect(
      normalizeResearchQuery("le client dit qu'il quitte son agence actuelle"),
    ).toBeNull();
    expect(normalizeResearchQuery("Pourquoi ils partent ?")).toBeNull();
  });
});
