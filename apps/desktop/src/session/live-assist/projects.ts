import {
  commands as miscCommands,
  type ProjectProviderRequest,
} from "@anlg/plugin-misc";

// Project context comes from a command the user configures (Settings ›
// Meetings). The app knows nothing about how projects are kept:
// - `<command> projects` prints a JSON list, `[{ "id", "name" }]`, only used
//   to pick the call's project by hand in the floating bar;
// - `<command> ask` reads a JSON request on stdin (the question, the call,
//   the last minutes of transcript, the project picked by hand or null) and
//   prints the Markdown context to answer with. Finding the project, what to
//   read and what to leave out is the command's job.

export type ProjectOption = { id: string; name: string };

export type ProjectAskInput = {
  question: string;
  origin: "auto" | "asked";
  // null: the command finds the project itself.
  projectId: string | null;
  call: {
    title: string | null;
    participants: Array<{ name: string; email: string | null }>;
  };
  transcript: string;
};

const MAX_CONTEXT_CHARS = 24_000;

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

export function parseProjects(stdout: string): ProjectOption[] {
  const json: unknown = JSON.parse(stdout);
  if (!Array.isArray(json)) {
    throw new Error("`projects` must print a JSON array");
  }
  return json.flatMap((item) => {
    const record = item as { id?: unknown; name?: unknown } | null;
    return typeof record?.id === "string" &&
      record.id &&
      typeof record.name === "string" &&
      record.name
      ? [{ id: record.id, name: record.name }]
      : [];
  });
}

export async function listProjects(command: string): Promise<ProjectOption[]> {
  return parseProjects(await run(command, { kind: "projects" }));
}

export async function askProject(
  command: string,
  input: ProjectAskInput,
): Promise<string> {
  const text = (
    await run(command, { kind: "ask", input: JSON.stringify(input) })
  ).trim();
  return text.length > MAX_CONTEXT_CHARS
    ? `${text.slice(0, MAX_CONTEXT_CHARS).trimEnd()}…`
    : text;
}
