import {
  commands as miscCommands,
  type ProjectProviderRequest,
} from "@anlg/plugin-misc";

// Project context comes from a command the user configures (Settings ›
// Meetings). The app knows nothing about how projects are kept, and never
// picks the call's project itself:
// - `<command> projects` reads the call (title, participants) as JSON on
//   stdin and prints every project, most likely first, for the picker;
// - `<command> context --project <id>` prints what the user knows about the
//   picked project, loaded once per call;
// - `<command> read --project <id> --section|--search <text>` prints more
//   passages, on the model's request.

export type ProjectOption = { id: string; label: string };

type CallInfo = {
  title: string | null;
  participants: Array<{ name: string; email: string | null }>;
};

export type ProjectPassage = { ref: string; text: string };

const MAX_CONTEXT_CHARS = 40_000;
const MAX_PASSAGES = 8;
const MAX_PASSAGES_CHARS = 16_000;

async function run(
  command: string,
  request: ProjectProviderRequest,
): Promise<unknown> {
  const result = await miscCommands.runProjectProvider(command, request);
  if (result.status === "error") {
    throw new Error(result.error);
  }
  return JSON.parse(result.data) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function clip(text: string, maxChars: number): string {
  return text.length > maxChars
    ? `${text.slice(0, maxChars).trimEnd()}…`
    : text;
}

export function parseProjects(json: unknown): ProjectOption[] {
  return (Array.isArray(json) ? json : []).flatMap((item) => {
    const project = asRecord(item);
    const id = asString(project.id);
    const label = asString(project.label);
    return id && label ? [{ id, label }] : [];
  });
}

export function parseContext(json: unknown): string {
  return clip(asString(asRecord(json).text) ?? "", MAX_CONTEXT_CHARS);
}

export function parsePassages(json: unknown): ProjectPassage[] {
  const passages = asRecord(json).passages;
  let total = 0;
  return (Array.isArray(passages) ? passages : [])
    .flatMap((item) => {
      const passage = asRecord(item);
      const ref = asString(passage.ref);
      const text = asString(passage.text);
      return ref && text ? [{ ref, text }] : [];
    })
    .slice(0, MAX_PASSAGES)
    .filter((passage) => {
      total += passage.text.length;
      return total <= MAX_PASSAGES_CHARS;
    });
}

export async function listProjects(
  command: string,
  call: CallInfo,
): Promise<ProjectOption[]> {
  return parseProjects(
    await run(command, { kind: "projects", input: JSON.stringify({ call }) }),
  );
}

export async function loadProjectContext(
  command: string,
  project: string,
): Promise<string> {
  return parseContext(await run(command, { kind: "context", project }));
}

export async function readProject(
  command: string,
  project: string,
  query: { section?: string; search?: string },
): Promise<ProjectPassage[]> {
  return parsePassages(
    await run(command, {
      kind: "read",
      project,
      section: query.section ?? null,
      search: query.search ?? null,
    }),
  );
}
