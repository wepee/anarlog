import { useMemo } from "react";

import { executeTransaction, liveQueryClient, useLiveQuery } from "~/db";
import { enqueueDatabaseWrite } from "~/db/write-queue";
import { getBaseLanguageCode } from "~/settings/general/language";
import { useConfigValue } from "~/shared/config";
import { getTranscriptionLanguages } from "~/stt/capabilities";

type SessionLanguageSqlRow = { language: string };

const SESSION_LANGUAGE_SELECT_SQL = `
  SELECT language
  FROM sessions
  WHERE id = ? AND deleted_at IS NULL
  LIMIT 1
`;

export function useSessionTranscriptLanguage(sessionId: string): string {
  const { data = "" } = useLiveQuery<SessionLanguageSqlRow, string>({
    sql: SESSION_LANGUAGE_SELECT_SQL,
    params: [sessionId],
    enabled: Boolean(sessionId),
    mapRows: (rows) => rows[0]?.language ?? "",
  });

  return data;
}

export async function readSessionTranscriptLanguage(
  sessionId: string,
): Promise<string> {
  if (!sessionId) {
    return "";
  }

  try {
    const rows = await liveQueryClient.execute<SessionLanguageSqlRow>(
      SESSION_LANGUAGE_SELECT_SQL,
      [sessionId],
    );
    return rows[0]?.language ?? "";
  } catch (error) {
    console.error("[stt] failed to read the note's transcript language", error);
    return "";
  }
}

export function setSessionTranscriptLanguage(
  sessionId: string,
  language: string,
): Promise<void> {
  return enqueueDatabaseWrite(`session:${sessionId}`, async () => {
    const now = new Date().toISOString();
    await executeTransaction([
      {
        sql: `
          UPDATE sessions
          SET language = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL
        `,
        params: [language, now, sessionId],
      },
    ]);
  });
}

// The note's own language wins, but the configured ones stay behind it so
// providers that accept several still get them. Apple Speech only reads the
// first one, which is exactly the mismatch this override exists to fix.
export function withSessionTranscriptLanguage(
  sessionLanguage: string | null | undefined,
  languages: readonly string[],
): string[] {
  const sessionLanguageCode = sessionLanguage ?? "";
  const baseCode = getBaseLanguageCode(sessionLanguageCode);
  if (!baseCode) {
    return [...languages];
  }

  return [
    sessionLanguageCode,
    ...languages.filter(
      (language) => getBaseLanguageCode(language) !== baseCode,
    ),
  ];
}

export function useTranscriptionLanguageChoices(): string[] {
  const aiLanguage = useConfigValue("ai_language");
  const spokenLanguages = useConfigValue("spoken_languages");

  return useMemo(
    () => getTranscriptionLanguages(aiLanguage, spokenLanguages),
    [aiLanguage, spokenLanguages],
  );
}
