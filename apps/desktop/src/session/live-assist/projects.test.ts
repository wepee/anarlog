import { describe, expect, it } from "vitest";

import { acceptProjectProposal, matchProject, parseProjects } from "./projects";

const projects = parseProjects(
  JSON.stringify([
    {
      id: "lumen",
      name: "Lumen Optique",
      aliases: ["Lumen", 42],
      emails: ["Claire.Morel@lumen-optique.fr", "adam@agence.fr"],
    },
    {
      id: "globex",
      name: "Globex",
      emails: ["adam@agence.fr", "jo@globex.com"],
      active: false,
    },
    { id: "broken" },
  ]),
);

describe("parseProjects", () => {
  it("keeps valid projects and normalizes what is optional", () => {
    expect(projects.map((project) => project.id)).toEqual(["lumen", "globex"]);
    expect(projects[0]).toMatchObject({
      aliases: ["Lumen"],
      emails: ["claire.morel@lumen-optique.fr", "adam@agence.fr"],
      people: [],
      description: "",
      active: true,
    });
  });
});

describe("matchProject", () => {
  it("decides only on a signal pointing to a single project", () => {
    expect(
      matchProject({
        projects,
        title: "Point hebdo",
        participantEmails: ["adam@agence.fr", "claire.morel@lumen-optique.fr"],
      }),
    ).toMatchObject({ project: { id: "lumen" }, reason: "email" });

    expect(
      matchProject({
        projects,
        title: "Point hebdo",
        participantEmails: ["adam@agence.fr"],
      }),
    ).toBeNull();

    expect(
      matchProject({
        projects,
        title: null,
        participantEmails: ["claire.morel@lumen-optique.fr", "jo@globex.com"],
      }),
    ).toBeNull();

    expect(
      matchProject({
        projects,
        title: "Démo LUMEN — suite",
        participantEmails: [],
      }),
    ).toMatchObject({ project: { id: "lumen" }, reason: "title" });

    expect(
      matchProject({ projects, title: "Illuminations", participantEmails: [] }),
    ).toBeNull();
  });
});

describe("acceptProjectProposal", () => {
  it("needs a quote that was actually said", () => {
    const transcript =
      "[02:10] Speaker 1: chez Lumen on veut revoir la prise de rendez-vous";
    const proposal = {
      projectId: "lumen",
      confidence: "high" as const,
      evidence: "chez Lumen on veut revoir la prise de rendez-vous",
    };

    expect(
      acceptProjectProposal(proposal, projects, transcript).projectId,
    ).toBe("lumen");
    expect(
      acceptProjectProposal(
        { ...proposal, evidence: "Lumen veut un nouveau site e-commerce" },
        projects,
        transcript,
      ).reason,
    ).toBe("evidence_not_in_transcript");
  });
});
