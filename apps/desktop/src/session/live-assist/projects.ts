import { z } from "zod";

import {
  commands as miscCommands,
  type ProjectProviderRequest,
} from "@anlg/plugin-misc";

// Projects come from a command the user configures (Settings › Meetings):
// `<command> projects` lists them as JSON, `<command> context <id>` prints the
// Markdown brief to give the model, and the optional `<command> search <id>
// <query>` returns excerpts. The app knows nothing about how the user keeps
// their projects.

export type Project = {
  id: string;
  name: string;
  aliases: string[];
  description: string;
  people: string[];
  emails: string[];
  active: boolean;
};

export type ProjectExcerpt = { ref: string; text: string };

export type LiveAssistProject = {
  id: string | null;
  source: "auto" | "manual";
};

const MAX_DESCRIPTION_CHARS = 400;
const MAX_CONTEXT_CHARS = 24_000;
const MAX_EXCERPTS = 5;
const MAX_EXCERPT_CHARS = 1_500;

const strings = z
  .array(z.unknown())
  .optional()
  .transform((values) =>
    (values ?? []).filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    ),
  );

const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  aliases: strings,
  description: z.string().optional(),
  people: strings,
  emails: strings,
  active: z.boolean().optional(),
});

function clip(text: string, maxChars: number): string {
  const trimmed = text.trim();
  return trimmed.length > maxChars
    ? `${trimmed.slice(0, maxChars).trimEnd()}…`
    : trimmed;
}

export function parseProjects(stdout: string): Project[] {
  const json: unknown = JSON.parse(stdout);
  if (!Array.isArray(json)) {
    throw new Error("`projects` must print a JSON array");
  }
  return json.flatMap((item) => {
    const parsed = projectSchema.safeParse(item);
    if (!parsed.success) {
      return [];
    }
    const project = parsed.data;
    return [
      {
        id: project.id,
        name: project.name,
        aliases: project.aliases,
        description: clip(project.description ?? "", MAX_DESCRIPTION_CHARS),
        people: project.people,
        emails: project.emails.map((email) => email.trim().toLowerCase()),
        active: project.active ?? true,
      },
    ];
  });
}

export function parseExcerpts(stdout: string): ProjectExcerpt[] {
  const json: unknown = JSON.parse(stdout);
  if (!Array.isArray(json)) {
    throw new Error("`search` must print a JSON array");
  }
  return json
    .flatMap((item) => {
      const record = item as { ref?: unknown; text?: unknown } | null;
      return typeof record?.ref === "string" &&
        typeof record.text === "string" &&
        record.text.trim()
        ? [{ ref: record.ref, text: clip(record.text, MAX_EXCERPT_CHARS) }]
        : [];
    })
    .slice(0, MAX_EXCERPTS);
}

async function run(
  command: string,
  request: ProjectProviderRequest,
): Promise<string> {
  const result = await miscCommands.runProjectProvider(command, request);
  if (result.status === "error") {
    throw new Error(result.error);
  }
  return result.data;
}

export async function listProjects(command: string): Promise<Project[]> {
  return parseProjects(await run(command, { kind: "projects" }));
}

export async function loadProjectBrief(
  command: string,
  id: string,
): Promise<string> {
  return clip(await run(command, { kind: "context", id }), MAX_CONTEXT_CHARS);
}

export async function searchProject(
  command: string,
  id: string,
  query: string,
): Promise<ProjectExcerpt[]> {
  return parseExcerpts(await run(command, { kind: "search", id, query }));
}

function fold(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

function containsWords(haystack: string, needle: string): boolean {
  const words = fold(needle)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (words.length === 0 || words.join("").length < 3) {
    return false;
  }
  const pattern = new RegExp(
    `(^|[^\\p{L}\\p{N}])${words.join("[^\\p{L}\\p{N}]+")}($|[^\\p{L}\\p{N}])`,
    "u",
  );
  return pattern.test(fold(haystack));
}

function single(projects: Project[]): Project | null {
  const ids = new Set(projects.map((project) => project.id));
  return ids.size === 1 ? projects[0]! : null;
}

// Rules 2 and 3: a signal decides only when it points to exactly one project.
// The user's own address, or a partner's found in several projects, decides
// nothing.
export function matchProject({
  projects,
  title,
  participantEmails,
}: {
  projects: Project[];
  title: string | null;
  participantEmails: string[];
}): { project: Project; reason: "email" | "title" } | null {
  // Each address counts on its own: only the ones found in a single project
  // decide, and they must agree.
  const byEmail = single(
    participantEmails.flatMap((address) => {
      const email = address.trim().toLowerCase();
      const found = single(
        projects.filter((project) => project.emails.includes(email)),
      );
      return found ? [found] : [];
    }),
  );
  if (byEmail) {
    return { project: byEmail, reason: "email" };
  }

  const byTitle = title
    ? single(
        projects.filter((project) =>
          [project.name, ...project.aliases].some((name) =>
            containsWords(title, name),
          ),
        ),
      )
    : null;
  return byTitle ? { project: byTitle, reason: "title" } : null;
}

const MIN_TRANSCRIPT_MENTIONS = 2;

function countMentions(haystack: string, needle: string): number {
  const words = fold(needle)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (words.length === 0 || words.join("").length < 3) {
    return 0;
  }
  const pattern = new RegExp(
    `(^|[^\\p{L}\\p{N}])${words.join("[^\\p{L}\\p{N}]+")}(?=$|[^\\p{L}\\p{N}])`,
    "gu",
  );
  return [...haystack.matchAll(pattern)].length;
}

// Rule 4, without a model: the project whose name, aliases or people are
// said at least twice in the call, clearly more than any other. A client
// mentioning another client once does not tip it.
export function matchProjectInTranscript(
  projects: Project[],
  transcript: string,
): { project: Project; mentions: number } | null {
  const folded = fold(transcript);
  const ranked = projects
    .map((project) => ({
      project,
      mentions: [project.name, ...project.aliases, ...project.people]
        .filter((name, index, all) => all.indexOf(name) === index)
        .reduce((total, name) => total + countMentions(folded, name), 0),
    }))
    .sort((a, b) => b.mentions - a.mentions);
  const [best, second] = ranked;
  if (!best || best.mentions < MIN_TRANSCRIPT_MENTIONS) {
    return null;
  }
  return second && second.mentions * 2 > best.mentions ? null : best;
}
