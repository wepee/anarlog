import type { MarkdownFile } from "@anlg/plugin-fs2";

import { loadObsidianVault } from "./knowledge";

import {
  buildPastSessionNotes,
  loadPastSessionNotesData,
} from "~/session/insights/past-notes";

const MAX_PAST_MEETINGS = 3;
const MAX_PAST_MEETING_CHARS = 1_500;
const MAX_OBSIDIAN_NOTES = 3;
const MAX_OBSIDIAN_NOTE_CHARS = 2_500;
// A term found in more than this share of the vault (the user's own name, a
// company's name in a single-company vault) says nothing about the project.
const MAX_TERM_SHARE = 0.3;

const GENERIC_TERMS = new Set([
  "appel",
  "avec",
  "between",
  "call",
  "catch",
  "demo",
  "démo",
  "meeting",
  "minutes",
  "point",
  "présentation",
  "réunion",
  "sync",
  "weekly",
]);

export type ProjectContext = {
  text: string;
  pastMeetings: string[];
  obsidianNotes: string[];
};

export const EMPTY_PROJECT_CONTEXT: ProjectContext = {
  text: "",
  pastMeetings: [],
  obsidianNotes: [],
};

function fold(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

export function getProjectTerms(
  title: string | null,
  participants: string[],
): string[] {
  const terms = new Set<string>();
  for (const name of participants) {
    const folded = fold(name).trim();
    if (folded.length >= 3) terms.add(folded);
  }
  for (const word of fold(title ?? "").split(/[^\p{L}\p{N}]+/u)) {
    if (word.length >= 4 && !GENERIC_TERMS.has(word)) terms.add(word);
  }
  return [...terms];
}

// Picks the vault notes about this call's project: the ones whose name or
// content mentions the client, the company or the people on the call. This is
// the single place to adapt to how a vault is organized (one folder per
// project, a knowledge graph index...).
export function selectProjectNotes(
  files: MarkdownFile[],
  terms: string[],
  limit = MAX_OBSIDIAN_NOTES,
): MarkdownFile[] {
  if (files.length === 0 || terms.length === 0) {
    return [];
  }
  const folded = files.map((file) => ({
    file,
    path: fold(file.path),
    body: fold(file.content),
  }));
  const usefulTerms = terms.filter((term) => {
    const hits = folded.filter(
      (entry) => entry.path.includes(term) || entry.body.includes(term),
    ).length;
    return hits > 0 && hits / files.length <= MAX_TERM_SHARE;
  });
  if (usefulTerms.length === 0) {
    return [];
  }

  return folded
    .map((entry) => {
      let score = 0;
      for (const term of usefulTerms) {
        if (entry.path.includes(term)) score += 5;
        score += Math.min(entry.body.split(term).length - 1, 5);
      }
      return { file: entry.file, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.file.modifiedMs - a.file.modifiedMs)
    .slice(0, limit)
    .map((entry) => entry.file);
}

function clip(text: string, maxChars: number): string {
  const compact = text.replace(/\n{3,}/g, "\n\n").trim();
  return compact.length > maxChars
    ? `${compact.slice(0, maxChars).trimEnd()}…`
    : compact;
}

// Built once when a call starts and sent with every live answer: what the
// user already knows about this project, from earlier meetings with the same
// people and from the Obsidian vault. When nothing matches, it stays empty and
// answers rely on general knowledge.
export async function buildProjectContext({
  sessionId,
  title,
  participants,
  obsidianPath,
  onError,
}: {
  sessionId: string;
  title: string | null;
  participants: string[];
  obsidianPath: string;
  onError: (source: "past_meetings" | "obsidian", error: unknown) => void;
}): Promise<ProjectContext> {
  const sections: string[] = [];
  const pastMeetings: string[] = [];
  const obsidianNotes: string[] = [];

  try {
    const data = await loadPastSessionNotesData();
    const userId = data.sessions[sessionId]?.user_id ?? null;
    const { notes, requests } = buildPastSessionNotes(data, sessionId, userId);
    const sourceById = new Map(
      requests.map((request) => [request.sessionId, request.sourceText]),
    );
    for (const note of notes.slice(0, MAX_PAST_MEETINGS)) {
      const body = note.summary ?? sourceById.get(note.sessionId) ?? "";
      if (!body.trim()) continue;
      pastMeetings.push(`${note.title} (${note.dateLabel})`);
      sections.push(
        `## Past meeting: ${note.title} (${note.dateLabel})\n${clip(body, MAX_PAST_MEETING_CHARS)}`,
      );
    }
  } catch (error) {
    onError("past_meetings", error);
  }

  if (obsidianPath) {
    try {
      const files = await loadObsidianVault(obsidianPath);
      for (const file of selectProjectNotes(
        files,
        getProjectTerms(title, participants),
      )) {
        obsidianNotes.push(file.path);
        sections.push(
          `## Obsidian note: ${file.path.replace(/\.md$/i, "")}\n${clip(file.content, MAX_OBSIDIAN_NOTE_CHARS)}`,
        );
      }
    } catch (error) {
      onError("obsidian", error);
    }
  }

  return { text: sections.join("\n\n"), pastMeetings, obsidianNotes };
}
