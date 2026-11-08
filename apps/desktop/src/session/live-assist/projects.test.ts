import { describe, expect, it } from "vitest";

import {
  matchProject,
  matchProjectInTranscript,
  parseProjects,
} from "./projects";

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

describe("matchProjectInTranscript", () => {
  it("needs the project named twice, clearly more than any other", () => {
    const call = [
      "[00:40] Speaker 1: Chez Lumen, on veut revoir la prise de rendez-vous.",
      "[02:10] Speaker 1: Comme chez Globex, mais en mieux.",
      "[05:30] You: Pour Lumen Optique, on peut démarrer en janvier.",
    ].join("\n");

    expect(matchProjectInTranscript(projects, call)?.project.id).toBe("lumen");
    expect(
      matchProjectInTranscript(projects, "Chez Lumen. Comme chez Globex."),
    ).toBeNull();
    expect(
      matchProjectInTranscript(projects, "Lumen, Lumen, Globex, Globex."),
    ).toBeNull();
  });
});
