import { describe, expect, it } from "vitest";

import { parseProjects } from "./projects";

describe("parseProjects", () => {
  it("keeps entries with an id and a name, whatever else they carry", () => {
    expect(
      parseProjects(
        JSON.stringify([
          { id: "lumen", name: "Lumen Optique", aliases: ["Lumen"] },
          { id: "broken" },
          "nope",
        ]),
      ),
    ).toEqual([{ id: "lumen", name: "Lumen Optique" }]);
  });
});
