import { getVersion } from "@tauri-apps/api/app";
import { downloadDir, join } from "@tauri-apps/api/path";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

import { commands as fs2Commands } from "@anlg/plugin-fs2";
import { commands as openerCommands } from "@anlg/plugin-opener2";
import { commands as tracingCommands } from "@anlg/plugin-tracing";

// A test journal for Live Assist, kept apart from app.log on purpose: app.log
// never records webview payloads, while this journal holds what is needed to
// understand a run (prompts, model answers, template decisions). It stays in
// memory, is appended to one file per app run next to the app logs, and only
// leaves the machine when the user copies or saves it.

type JournalEntry = {
  at: number;
  event: string;
  sessionId?: string;
  data?: unknown;
};

const MAX_ENTRIES = 4_000;
const PERSIST_DEBOUNCE_MS = 2_000;
const runStartedAt = new Date();
const entries: JournalEntry[] = [];
let persistTimer: ReturnType<typeof setTimeout> | null = null;
// Entries not yet written to the file.
let unwritten: JournalEntry[] = [];
let fileStarted = false;
let persistPath: Promise<string | null> | null = null;

export function liveAssistLog(
  event: string,
  data?: unknown,
  sessionId?: string,
) {
  const entry: JournalEntry = { at: Date.now(), event, sessionId, data };
  entries.push(entry);
  unwritten.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
  console.debug(`[live-assist] ${event}`, data ?? "");
  schedulePersist();
}

type DescribedError = {
  name?: string;
  message: string;
  stack?: string;
  cause?: DescribedError;
};

export function describeError(error: unknown): DescribedError {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    return {
      name: error.name,
      message: error.message,
      stack: error.stack?.split("\n").slice(0, 8).join("\n"),
      ...(cause ? { cause: describeError(cause) } : {}),
    };
  }
  return { message: String(error) };
}

export function describeModel(model: unknown) {
  if (!model) return null;
  if (typeof model === "string") return { modelId: model };
  const record = model as { provider?: unknown; modelId?: unknown };
  return {
    provider: typeof record.provider === "string" ? record.provider : null,
    modelId: typeof record.modelId === "string" ? record.modelId : null,
  };
}

export async function formatLiveAssistJournal(): Promise<string> {
  const version = await getVersion().catch(() => "unknown");
  const header = [
    "BlackMushi · Live Assist journal",
    `App version: ${version}`,
    `App run started: ${runStartedAt.toISOString()}`,
    `Exported: ${new Date().toISOString()}`,
    `Entries: ${entries.length}${entries.length >= MAX_ENTRIES ? ` (oldest dropped, cap ${MAX_ENTRIES})` : ""}`,
    "Contains transcript excerpts, prompts and model answers from your calls.",
    "",
  ];
  return [...header, ...entries.map(formatEntry), ""].join("\n");
}

function formatEntry(entry: JournalEntry): string {
  const time = new Date(entry.at).toISOString();
  const session = entry.sessionId ? ` [${entry.sessionId}]` : "";
  const data =
    entry.data === undefined ? "" : `\n${indent(stringify(entry.data))}`;
  return `${time}${session} ${entry.event}${data}`;
}

export async function copyLiveAssistJournal(): Promise<void> {
  await writeText(await formatLiveAssistJournal());
}

// Saves the journal to the Downloads folder and shows it in the file
// manager, ready to attach to a message.
export async function saveLiveAssistJournal(): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = await join(await downloadDir(), `live-assist-${stamp}.log`);
  const result = await fs2Commands.writeTextFile(
    path,
    await formatLiveAssistJournal(),
  );
  if (result.status === "error") {
    throw new Error(result.error);
  }
  liveAssistLog("journal.saved", { path });
  try {
    await openerCommands.revealItemInDir(path);
  } catch {
    // Saving worked; showing the file is a convenience.
  }
  return path;
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persist();
  }, PERSIST_DEBOUNCE_MS);
}

async function persist() {
  const batch = unwritten;
  unwritten = [];
  try {
    persistPath ??= resolvePersistPath();
    const path = await persistPath;
    if (!path || batch.length === 0) return;
    const header = fileStarted
      ? ""
      : `BlackMushi · Live Assist journal · app run started ${runStartedAt.toISOString()}\n`;
    fileStarted = true;
    await fs2Commands.appendTextFile(
      path,
      `${header}${batch.map(formatEntry).join("\n")}\n`,
    );
  } catch {
    // Best effort: the in-memory journal stays available for export.
  }
}

async function resolvePersistPath(): Promise<string | null> {
  let dir: Awaited<ReturnType<typeof tracingCommands.logsDir>>;
  try {
    dir = await tracingCommands.logsDir();
  } catch {
    return null;
  }
  if (dir.status === "error") return null;
  const stamp = runStartedAt.toISOString().replace(/[:.]/g, "-");
  return join(dir.data, `live-assist-${stamp}.log`);
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

export function resetLiveAssistJournalForTests() {
  entries.length = 0;
  unwritten = [];
}
