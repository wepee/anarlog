import {
  buildPastSessionNotes,
  loadPastSessionNotesData,
} from "~/session/insights/past-notes";

const MAX_PAST_MEETINGS = 3;
const MAX_PAST_MEETING_CHARS = 1_500;

export type PastMeetings = { text: string; titles: string[] };

export const NO_PAST_MEETINGS: PastMeetings = { text: "", titles: [] };

function clip(text: string, maxChars: number): string {
  const compact = text.replace(/\n{3,}/g, "\n\n").trim();
  return compact.length > maxChars
    ? `${compact.slice(0, maxChars).trimEnd()}…`
    : compact;
}

// Loaded once when a call starts: the latest meetings with the same people,
// so answers know what was said last time.
export async function loadPastMeetings(
  sessionId: string,
): Promise<PastMeetings> {
  const data = await loadPastSessionNotesData();
  const userId = data.sessions[sessionId]?.user_id ?? null;
  const { notes, requests } = buildPastSessionNotes(data, sessionId, userId);
  const sourceById = new Map(
    requests.map((request) => [request.sessionId, request.sourceText]),
  );
  const sections: string[] = [];
  const titles: string[] = [];
  for (const note of notes.slice(0, MAX_PAST_MEETINGS)) {
    const body = note.summary ?? sourceById.get(note.sessionId) ?? "";
    if (!body.trim()) continue;
    titles.push(`${note.title} (${note.dateLabel})`);
    sections.push(
      `## ${note.title} (${note.dateLabel})\n${clip(body, MAX_PAST_MEETING_CHARS)}`,
    );
  }
  return { text: sections.join("\n\n"), titles };
}
