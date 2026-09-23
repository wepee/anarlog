import { md2json } from "@anlg/editor/markdown";
import { commands as fsSyncCommands } from "@anlg/plugin-fs-sync";
import type { ImportTextFile } from "@anlg/plugin-importer";

import type { FirefliesExportBundleFile } from "./fireflies-export";
import { parseMeetingExport, type ImportedMeeting } from "./parser";

import { executeTransaction, liveQueryClient, useLiveQuery } from "~/db";
import { catalogLocalSessionAudio } from "~/session/attachments";
import { DEFAULT_USER_ID, id } from "~/shared/utils";

const IMPORTER_VERSION = 2;
export const EMPTY_MEETING_IMPORT_HISTORY: MeetingImportRun[] = [];

type ImportItemRow = {
  discovered_count: number;
  settled_target_count: number;
};
type SessionIdRow = { id: string; import_key: string };
type ExternalMeetingIdRow = { external_event_id: string };
type MeetingImportMode = "connection" | "export";

export type MeetingImportResult = {
  discovered: number;
  imported: number;
  matched: number;
  conflicts: number;
  errors: number;
};

export type MeetingImportRun = MeetingImportResult & {
  id: string;
  providerId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
};

export function useMeetingImportHistory() {
  return useLiveQuery<
    {
      id: string;
      source_root: string;
      status: string;
      discovered_count: number;
      imported_count: number;
      matched_count: number;
      conflict_count: number;
      error_count: number;
      started_at: string;
      completed_at: string | null;
    },
    MeetingImportRun[]
  >({
    sql: `
      SELECT id, source_root, status, discovered_count, imported_count,
        matched_count, conflict_count, error_count, started_at, completed_at
      FROM migration_import_runs
      WHERE source_root LIKE 'meeting-import:%'
      ORDER BY started_at DESC
      LIMIT 20
    `,
    mapRows: (rows) =>
      rows.map((row) => ({
        id: row.id,
        providerId: row.source_root.slice("meeting-import:".length),
        status: row.status,
        discovered: row.discovered_count,
        imported: row.imported_count,
        matched: row.matched_count,
        conflicts: row.conflict_count,
        errors: row.error_count,
        startedAt: row.started_at,
        completedAt: row.completed_at,
      })),
  });
}

export async function getImportedMeetingIds(providerId: string) {
  const rows = await liveQueryClient.execute<ExternalMeetingIdRow>(
    `
      SELECT external_event_id
      FROM sessions
      WHERE external_provider = ? AND external_event_id <> ''
        AND deleted_at IS NULL
    `,
    [providerId],
  );
  return rows.map((row) => row.external_event_id);
}

export async function importMeetingFiles(
  providerId: string,
  files: ImportTextFile[],
): Promise<MeetingImportResult> {
  if (files.length === 0) throw new Error("Select at least one export file");

  return runMeetingImport(providerId, files, "export");
}

export async function importFirefliesExportBundles(
  bundles: FirefliesExportBundleFile[],
): Promise<MeetingImportResult> {
  if (bundles.length === 0) {
    throw new Error("Select at least one Fireflies export folder");
  }

  const audioPathByFilePath = new Map(
    bundles
      .filter((bundle) => bundle.audioPath)
      .map((bundle) => [bundle.file.path, bundle.audioPath]),
  );

  return runMeetingImport(
    "fireflies",
    bundles.map((bundle) => bundle.file),
    "export",
    (file) => audioPathByFilePath.get(file.path),
  );
}

export async function importConnectedMeetings(
  providerId: string,
  files: ImportTextFile[],
): Promise<MeetingImportResult> {
  if (files.length === 0) {
    return {
      discovered: 0,
      imported: 0,
      matched: 0,
      conflicts: 0,
      errors: 0,
    };
  }

  return runMeetingImport(providerId, files, "connection");
}

async function runMeetingImport(
  providerId: string,
  files: ImportTextFile[],
  mode: MeetingImportMode,
  getAudioPath?: (file: ImportTextFile) => string | undefined,
): Promise<MeetingImportResult> {
  const runId = id();
  const sourceKind = `meeting-${mode}:${providerId}`;
  const totals: MeetingImportResult = {
    discovered: 0,
    imported: 0,
    matched: 0,
    conflicts: 0,
    errors: 0,
  };

  await executeTransaction([
    {
      sql: `
        INSERT INTO migration_import_runs (
          id, importer_version, source_root, dry_run, status
        ) VALUES (?, ?, ?, 0, 'running')
      `,
      params: [runId, IMPORTER_VERSION, `meeting-import:${providerId}`],
    },
  ]);

  for (const [fileIndex, file] of files.entries()) {
    const itemId = `${runId}:item:${fileIndex}`;
    const sourceSha256 = await sha256(file.content);
    const prior = await findPriorImport(file.path, sourceKind, sourceSha256);
    if (prior) {
      totals.discovered += prior.discovered_count;
      totals.matched += prior.discovered_count;
      await recordUnchangedItem({
        itemId,
        runId,
        file,
        sourceKind,
        sourceSha256,
        discovered: prior.discovered_count,
      });
      continue;
    }

    try {
      const meetings = parseMeetingExport(file);
      const targets = await Promise.all(
        meetings.map(async (meeting, meetingIndex) => {
          const importKey = `${providerId}:${
            meeting.externalId || `${file.path}#${meetingIndex}`
          }`;
          return {
            meeting,
            importKey,
            legacySessionId: await legacySessionId(importKey),
            sessionId: id(),
          };
        }),
      );
      const existing = await findExistingMeetings(targets);
      const importedTargets = targets.filter(
        (target) => !existing.has(target.importKey),
      );

      const statements: Array<{ sql: string; params: unknown[] }> = [];
      for (const target of importedTargets) {
        statements.push(
          ...buildMeetingStatements({
            providerId,
            sourcePath: file.path,
            sessionId: target.sessionId,
            importKey: target.importKey,
            meeting: target.meeting,
          }),
        );
      }

      const existingCount = targets.length - importedTargets.length;
      const matchedCount = mode === "connection" ? existingCount : 0;
      const conflictCount = mode === "export" ? existingCount : 0;
      statements.push({
        sql: `
          INSERT INTO migration_import_items (
            id, run_id, source_path, source_kind, source_sha256, status,
            discovered_count, imported_count, matched_count, skipped_count,
            conflict_count, error, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, '', ?)
        `,
        params: [
          itemId,
          runId,
          file.path,
          sourceKind,
          sourceSha256,
          conflictCount > 0 ? "conflict" : "complete",
          targets.length,
          importedTargets.length,
          matchedCount,
          conflictCount,
          new Date().toISOString(),
        ],
      });
      for (const target of targets) {
        statements.push({
          sql: `
            INSERT INTO migration_import_targets (
              id, run_id, item_id, source_path, source_kind, table_name,
              target_id, status
            ) VALUES (?, ?, ?, ?, ?, 'sessions', ?, ?)
          `,
          params: [
            `${itemId}:session:${target.sessionId}`,
            runId,
            itemId,
            file.path,
            sourceKind,
            existing.get(target.importKey) ?? target.sessionId,
            existing.has(target.importKey)
              ? mode === "connection"
                ? "matched"
                : "conflict"
              : "inserted",
          ],
        });
      }
      await executeTransaction(statements);

      const audioPath = getAudioPath?.(file);
      if (audioPath) {
        for (const target of importedTargets) {
          await importSessionAudio(target.sessionId, audioPath).catch(
            (error) => {
              console.error("[import] failed to import session audio", error);
            },
          );
        }
      }

      totals.discovered += targets.length;
      totals.imported += importedTargets.length;
      totals.matched += matchedCount;
      totals.conflicts += conflictCount;
    } catch (error) {
      totals.discovered += 1;
      totals.errors += 1;
      await recordImportError({
        itemId,
        runId,
        file,
        sourceKind,
        sourceSha256,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const status =
    totals.errors > 0
      ? "completed_with_issues"
      : totals.conflicts > 0
        ? "completed_with_conflicts"
        : "completed";
  await executeTransaction([
    {
      sql: `
        UPDATE migration_import_runs
        SET status = ?, discovered_count = ?, imported_count = ?,
          matched_count = ?, skipped_count = ?, conflict_count = ?,
          error_count = ?, completed_at = ?
        WHERE id = ?
      `,
      params: [
        status,
        totals.discovered,
        totals.imported,
        totals.matched,
        totals.errors,
        totals.conflicts,
        totals.errors,
        new Date().toISOString(),
        runId,
      ],
    },
  ]);

  return totals;
}

// Imported transcripts have no channel separation, so every speaker shares the
// direct-mic channel and is told apart by its provider speaker index.
const IMPORTED_TRANSCRIPT_CHANNEL = 0;

type ImportedSpeaker = { name: string; humanId: string; speakerIndex: number };

type ImportedSpeakerHint = {
  id: string;
  word_id: string;
  type: string;
  value: string;
};

function speakerKey(speaker: string): string {
  return speaker.trim().replace(/\s+/gu, " ").toLowerCase();
}

export function collectTranscriptSpeakers(
  transcript: ImportedMeeting["transcript"],
): Map<string, ImportedSpeaker> {
  const speakers = new Map<string, ImportedSpeaker>();

  for (const segment of transcript) {
    const key = speakerKey(segment.speaker);
    if (!key || speakers.has(key)) {
      continue;
    }

    speakers.set(key, {
      name: segment.speaker.trim().replace(/\s+/gu, " "),
      humanId: `import-speaker:${key}`,
      speakerIndex: speakers.size,
    });
  }

  return speakers;
}

function buildImportedSpeakerHints(
  transcript: ImportedMeeting["transcript"],
  words: Array<{ id: string }>,
  speakers: Map<string, ImportedSpeaker>,
): ImportedSpeakerHint[] {
  const hints: ImportedSpeakerHint[] = [];
  const anchorWordIdBySpeaker = new Map<string, string>();

  for (const [index, segment] of transcript.entries()) {
    const speaker = speakers.get(speakerKey(segment.speaker));
    const wordId = words[index]?.id;
    if (!speaker || !wordId) {
      continue;
    }

    if (!anchorWordIdBySpeaker.has(speaker.humanId)) {
      anchorWordIdBySpeaker.set(speaker.humanId, wordId);
    }

    hints.push({
      id: `${wordId}:provider_speaker_index`,
      word_id: wordId,
      type: "provider_speaker_index",
      value: JSON.stringify({
        channel: IMPORTED_TRANSCRIPT_CHANNEL,
        speaker_index: speaker.speakerIndex,
      }),
    });
  }

  for (const speaker of speakers.values()) {
    const anchorWordId = anchorWordIdBySpeaker.get(speaker.humanId);
    if (!anchorWordId) {
      continue;
    }

    hints.push({
      id: `${anchorWordId}:user_speaker_assignment`,
      word_id: anchorWordId,
      type: "user_speaker_assignment",
      value: JSON.stringify({
        human_id: speaker.humanId,
        scope: "speaker",
        channel: IMPORTED_TRANSCRIPT_CHANNEL,
        speaker_index: speaker.speakerIndex,
      }),
    });
  }

  return hints;
}

export function buildMeetingStatements({
  providerId,
  sourcePath,
  sessionId,
  importKey,
  meeting,
}: {
  providerId: string;
  sourcePath: string;
  sessionId: string;
  importKey: string;
  meeting: ImportedMeeting;
}) {
  const now = new Date().toISOString();
  const createdAt = meeting.startedAt || now;
  const metadata = JSON.stringify({
    importedFrom: providerId,
    sourcePath,
    sourceUrl: meeting.sourceUrl,
    externalId: meeting.externalId,
    importKey,
  });
  const statements: Array<{ sql: string; params: unknown[] }> = [
    {
      sql: `
        INSERT INTO sessions (
          id, workspace_id, owner_user_id, title, created_at, updated_at,
          started_at, ended_at, external_event_id, external_provider,
          metadata_json, deleted_at
        ) VALUES (?, NULLIF((
          SELECT json_extract(value_json, '$.workspace_id')
          FROM app_settings WHERE id = 'cloudsync_workspace_binding'
        ), ''), COALESCE(NULLIF((
          SELECT json_extract(value_json, '$.workspace_id')
          FROM app_settings WHERE id = 'cloudsync_workspace_binding'
        ), ''), ?), ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `,
      params: [
        sessionId,
        DEFAULT_USER_ID,
        meeting.title,
        createdAt,
        now,
        meeting.startedAt,
        meeting.endedAt,
        meeting.externalId,
        providerId,
        metadata,
      ],
    },
    {
      sql: `
        INSERT INTO session_documents (
          id, workspace_id, session_id, kind, title, body_format, body,
          created_by, updated_by, created_at, updated_at, deleted_at
        ) SELECT ?, workspace_id, id, 'note', ?, 'prosemirror_json', ?,
          owner_user_id, owner_user_id, ?, ?, NULL
        FROM sessions WHERE id = ? AND deleted_at IS NULL
      `,
      params: [
        sessionId,
        meeting.title,
        JSON.stringify(md2json(meeting.noteMarkdown)),
        createdAt,
        now,
        sessionId,
      ],
    },
  ];

  // The provider already wrote the summary, so it belongs next to the enhanced
  // notes the app generates rather than inside the user's memo.
  if (meeting.summaryMarkdown) {
    statements.push({
      sql: `
        INSERT INTO session_documents (
          id, workspace_id, session_id, kind, template_id, title, body_format,
          body, sort_order, created_by, updated_by, created_at, updated_at,
          deleted_at
        ) SELECT ?, workspace_id, id, 'summary', '', 'Summary',
          'prosemirror_json', ?, 1, owner_user_id, owner_user_id, ?, ?, NULL
        FROM sessions WHERE id = ? AND deleted_at IS NULL
      `,
      params: [
        `${sessionId}:summary`,
        JSON.stringify(md2json(meeting.summaryMarkdown)),
        createdAt,
        now,
        sessionId,
      ],
    });
  }

  if (meeting.transcript.length > 0) {
    const speakers = collectTranscriptSpeakers(meeting.transcript);
    const words = meeting.transcript.map((segment, index) => {
      const speaker = speakers.get(speakerKey(segment.speaker));
      return {
        id: `${sessionId}:word:${index}`,
        text: segment.text,
        start_ms: segment.startMs,
        end_ms: segment.endMs,
        channel: IMPORTED_TRANSCRIPT_CHANNEL,
        ...(speaker ? { speaker: speaker.name } : {}),
      };
    });
    const speakerHints = buildImportedSpeakerHints(
      meeting.transcript,
      words,
      speakers,
    );

    for (const speaker of speakers.values()) {
      statements.push({
        sql: `
          INSERT INTO humans (
            id, workspace_id, owner_user_id, name, created_at, updated_at,
            deleted_at
          ) SELECT ?, workspace_id, owner_user_id, ?, ?, ?, NULL
          FROM sessions WHERE id = ? AND deleted_at IS NULL
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            deleted_at = NULL,
            updated_at = excluded.updated_at
        `,
        params: [speaker.humanId, speaker.name, createdAt, now, sessionId],
      });
    }

    statements.push({
      sql: `
        INSERT INTO transcripts (
          id, workspace_id, owner_user_id, session_id, source, provider,
          started_at_ms, ended_at_ms, words_json, speaker_hints_json,
          metadata_json, created_at, updated_at, deleted_at
        ) SELECT ?, workspace_id, owner_user_id, id, 'import', ?, ?, ?, ?,
          ?, ?, ?, ?, NULL
        FROM sessions WHERE id = ? AND deleted_at IS NULL
      `,
      params: [
        `${sessionId}:transcript`,
        providerId,
        words[0]?.start_ms ?? 0,
        words[words.length - 1]?.end_ms ?? null,
        JSON.stringify(words),
        JSON.stringify(speakerHints),
        metadata,
        createdAt,
        now,
        sessionId,
      ],
    });
  }

  for (const [index, attendee] of meeting.attendees.entries()) {
    statements.push({
      sql: `
        INSERT INTO session_participants (
          id, workspace_id, owner_user_id, session_id, display_name, email,
          source, created_at, updated_at, deleted_at
        ) SELECT ?, workspace_id, owner_user_id, id, ?, ?, 'auto', ?, ?, NULL
        FROM sessions WHERE id = ? AND deleted_at IS NULL
      `,
      params: [
        `${sessionId}:participant:${index}`,
        attendee.name,
        attendee.email,
        createdAt,
        now,
        sessionId,
      ],
    });
  }

  for (const [index, actionItem] of meeting.actionItems.entries()) {
    statements.push({
      sql: `
        INSERT INTO action_items (
          id, workspace_id, created_by, updated_by, session_id, source_type,
          source_id, source_order, status, text, body_json, created_at,
          updated_at, deleted_at
        ) SELECT ?, workspace_id, owner_user_id, owner_user_id, id, 'import',
          ?, ?, 'todo', ?, ?, ?, ?, NULL
        FROM sessions WHERE id = ? AND deleted_at IS NULL
      `,
      params: [
        `${sessionId}:action:${index}`,
        sessionId,
        index,
        actionItem,
        JSON.stringify([
          {
            type: "paragraph",
            content: [{ type: "text", text: actionItem }],
          },
        ]),
        createdAt,
        now,
        sessionId,
      ],
    });
  }

  return statements;
}

// A file that only ever produced conflicts imported nothing, so its hash must
// not shortcut later runs the way a file that really landed does.
export function isPriorImportSettled(row: ImportItemRow) {
  return row.settled_target_count > 0;
}

async function findPriorImport(
  sourcePath: string,
  sourceKind: string,
  sourceSha256: string,
) {
  const rows = await liveQueryClient.execute<ImportItemRow>(
    `
      SELECT item.discovered_count, (
        SELECT COUNT(*)
        FROM migration_import_targets AS target
        WHERE target.source_path = item.source_path
          AND target.source_kind = item.source_kind
          AND target.table_name = 'sessions'
          AND target.status <> 'conflict'
      ) AS settled_target_count
      FROM migration_import_items AS item
      JOIN migration_import_runs AS run ON run.id = item.run_id
      WHERE item.source_path = ? AND item.source_kind = ?
        AND item.source_sha256 = ?
        AND item.status IN ('complete', 'unchanged')
        AND run.importer_version = ? AND run.dry_run = 0
      ORDER BY item.created_at DESC
      LIMIT 1
    `,
    [sourcePath, sourceKind, sourceSha256, IMPORTER_VERSION],
  );
  const row = rows[0];
  return row && isPriorImportSettled(row) ? row : undefined;
}

// Imports before this used a hash of the import key as the session id, which
// the vault rejects as a directory name. New sessions get a real UUID, so the
// key they were imported under is matched through the metadata instead, and the
// old id keeps recognising everything imported before the change.
async function findExistingMeetings(
  targets: Array<{ importKey: string; legacySessionId: string }>,
) {
  if (targets.length === 0) return new Map<string, string>();
  const rows = await liveQueryClient.execute<SessionIdRow>(
    `
      SELECT id, COALESCE(json_extract(metadata_json, '$.importKey'), '')
        AS import_key
      FROM sessions
      WHERE id IN (${targets.map(() => "?").join(",")})
        OR json_extract(metadata_json, '$.importKey')
          IN (${targets.map(() => "?").join(",")})
    `,
    [
      ...targets.map((target) => target.legacySessionId),
      ...targets.map((target) => target.importKey),
    ],
  );
  const legacyIds = new Map(
    targets.map((target) => [target.legacySessionId, target.importKey]),
  );
  return new Map(
    rows.map((row) => [row.import_key || legacyIds.get(row.id) || "", row.id]),
  );
}

async function recordUnchangedItem({
  itemId,
  runId,
  file,
  sourceKind,
  sourceSha256,
  discovered,
}: {
  itemId: string;
  runId: string;
  file: ImportTextFile;
  sourceKind: string;
  sourceSha256: string;
  discovered: number;
}) {
  await executeTransaction([
    {
      sql: `
        INSERT INTO migration_import_items (
          id, run_id, source_path, source_kind, source_sha256, status,
          discovered_count, imported_count, matched_count, completed_at
        ) VALUES (?, ?, ?, ?, ?, 'unchanged', ?, 0, ?, ?)
      `,
      params: [
        itemId,
        runId,
        file.path,
        sourceKind,
        sourceSha256,
        discovered,
        discovered,
        new Date().toISOString(),
      ],
    },
  ]);
}

async function recordImportError({
  itemId,
  runId,
  file,
  sourceKind,
  sourceSha256,
  error,
}: {
  itemId: string;
  runId: string;
  file: ImportTextFile;
  sourceKind: string;
  sourceSha256: string;
  error: string;
}) {
  await executeTransaction([
    {
      sql: `
        INSERT INTO migration_import_items (
          id, run_id, source_path, source_kind, source_sha256, status,
          discovered_count, skipped_count, error, completed_at
        ) VALUES (?, ?, ?, ?, ?, 'error', 1, 1, ?, ?)
      `,
      params: [
        itemId,
        runId,
        file.path,
        sourceKind,
        sourceSha256,
        error,
        new Date().toISOString(),
      ],
    },
  ]);
}

async function legacySessionId(importKey: string) {
  return `meeting-import:${await sha256(importKey)}`;
}

async function importSessionAudio(sessionId: string, sourcePath: string) {
  const result = await fsSyncCommands.audioImport(sessionId, sourcePath);
  if (result.status === "error") {
    throw new Error(result.error);
  }
  await catalogLocalSessionAudio(sessionId);
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
