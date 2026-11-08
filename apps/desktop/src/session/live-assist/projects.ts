import {
  commands as miscCommands,
  type ProjectProviderRequest,
} from "@anlg/plugin-misc";

// Project context comes from a command the user configures (Settings ›
// Meetings). The app knows nothing about how projects are kept:
// - `<command> route` reads the call as JSON on stdin and prints the call's
//   project when a sure signal names it (an email, the name said in the
//   call), plus every project sorted by how well it fits, for the picker;
// - `<command> context --project <id>` prints what the user knows about the
//   project, loaded once per call;
// - `<command> read --project <id> --section|--search <text>` prints more
//   passages, on the model's request.

export type ProjectOption = { id: string; label: string };

export type RouteInput = {
  call: {
    title: string | null;
    participants: Array<{ name: string; email: string | null }>;
  };
  transcript: string;
};

export type RouteResult = {
  projectId: string | null;
  reason: string | null;
  projects: ProjectOption[];
};

export type ProjectPassage = { ref: string; text: string };

const MAX_CONTEXT_CHARS = 40_000;
const MAX_PASSAGES = 8;
const MAX_PASSAGES_CHARS = 16_000;
const MAX_ROUTE_TRANSCRIPT_CHARS = 40_000;
const ROUTE_TRANSCRIPT_HEAD_CHARS = 10_000;

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

export function parseRouteResult(json: unknown): RouteResult {
  const record = asRecord(json);
  const projects = (
    Array.isArray(record.projects) ? record.projects : []
  ).flatMap((item) => {
    const project = asRecord(item);
    const id = asString(project.id);
    const label = asString(project.label);
    return id && label ? [{ id, label }] : [];
  });
  const projectId = asString(record.projectId);
  return {
    projectId:
      projectId && projects.some((project) => project.id === projectId)
        ? projectId
        : null,
    reason: asString(record.reason),
    projects,
  };
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

// The start of a call says who is on it and why; the end, what it is about
// now. A long call keeps both.
export function routeTranscript(transcript: string): string {
  if (transcript.length <= MAX_ROUTE_TRANSCRIPT_CHARS) {
    return transcript;
  }
  const tail = MAX_ROUTE_TRANSCRIPT_CHARS - ROUTE_TRANSCRIPT_HEAD_CHARS;
  return `${transcript.slice(0, ROUTE_TRANSCRIPT_HEAD_CHARS)}\n…\n${transcript.slice(-tail)}`;
}

export async function routeCall(
  command: string,
  input: RouteInput,
): Promise<RouteResult> {
  return parseRouteResult(
    await run(command, {
      kind: "route",
      input: JSON.stringify({
        ...input,
        transcript: routeTranscript(input.transcript),
      }),
    }),
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
