import { describe, expect, it } from "vitest";

import { buildMeetingStatements, isPriorImportSettled } from "./queries";

import { buildRenderTranscriptRequestFromRows } from "~/stt/render-transcript";

describe("meeting import statements", () => {
  it("creates every supported meeting record without overwriting sessions", () => {
    const statements = buildMeetingStatements({
      providerId: "otter",
      sourcePath: "/exports/meeting.json",
      sessionId: "11111111-1111-4111-8111-111111111111",
      importKey: "otter:external-one",
      meeting: {
        externalId: "external-one",
        title: "Weekly planning",
        startedAt: "2026-08-06T01:00:00.000Z",
        endedAt: "2026-08-06T01:30:00.000Z",
        sourceUrl: "https://otter.ai/u/one",
        noteMarkdown: "Ship on Friday.",
        summaryMarkdown: "Decided to ship.",
        transcript: [
          {
            speaker: "Ada",
            text: "Let's ship.",
            startMs: 0,
            endMs: 1_000,
          },
        ],
        attendees: [{ name: "Ada", email: "ada@example.com" }],
        actionItems: ["Prepare the release"],
      },
    });

    for (const table of [
      "sessions",
      "session_documents",
      "transcripts",
      "session_participants",
      "action_items",
    ]) {
      expect(
        statements.some(({ sql }) => sql.includes(`INSERT INTO ${table}`)),
      ).toBe(true);
    }
    expect(
      statements.every(({ sql }) => !sql.includes("UPDATE sessions")),
    ).toBe(true);
    for (const statement of statements) {
      expect(statement.sql.match(/\?/gu)?.length ?? 0).toBe(
        statement.params.length,
      );
    }
  });
});

describe("imported transcript speakers", () => {
  const meeting = {
    externalId: "external-two",
    title: "Weekly CEOs",
    startedAt: "2026-08-17T12:45:50.640Z",
    endedAt: "2026-08-17T13:30:33.552Z",
    sourceUrl: "https://fireflies.ai/view/two",
    noteMarkdown: "",
    summaryMarkdown: "Everyone agreed.",
    transcript: [
      { speaker: "Marwane Lairi", text: "Selam.", startMs: 0, endMs: 1_000 },
      {
        speaker: "Ayman Berriga",
        text: "Selam.",
        startMs: 1_000,
        endMs: 2_000,
      },
      {
        speaker: "marwane lairi",
        text: "On y va.",
        startMs: 2_000,
        endMs: 3_000,
      },
      { speaker: "", text: "Merci.", startMs: 3_000, endMs: 4_000 },
    ],
    attendees: [],
    actionItems: [],
  };

  const statements = buildMeetingStatements({
    providerId: "fireflies",
    sourcePath: "/exports/two/transcript.json",
    sessionId: "22222222-2222-4222-8222-222222222222",
    importKey: "fireflies:external-two",
    meeting,
  });

  const transcriptStatement = statements.find(({ sql }) =>
    sql.includes("INSERT INTO transcripts"),
  );

  it("assigns a stable speaker index per distinct speaker name", () => {
    const hints = JSON.parse(String(transcriptStatement?.params[5])) as Array<{
      word_id: string;
      type: string;
      value: string;
    }>;
    const providerHints = hints.filter(
      (hint) => hint.type === "provider_speaker_index",
    );

    expect(providerHints).toHaveLength(3);
    expect(
      providerHints.map((hint) => JSON.parse(hint.value).speaker_index),
    ).toEqual([0, 1, 0]);
  });

  it("names each speaker through a human-scoped assignment", () => {
    const hints = JSON.parse(String(transcriptStatement?.params[5])) as Array<{
      word_id: string;
      type: string;
      value: string;
    }>;
    const assignments = hints
      .filter((hint) => hint.type === "user_speaker_assignment")
      .map((hint) => JSON.parse(hint.value));

    expect(assignments).toEqual([
      {
        human_id: "import-speaker:marwane lairi",
        scope: "speaker",
        channel: 0,
        speaker_index: 0,
      },
      {
        human_id: "import-speaker:ayman berriga",
        scope: "speaker",
        channel: 0,
        speaker_index: 1,
      },
    ]);
    expect(
      statements.filter(({ sql }) => sql.includes("INSERT INTO humans")),
    ).toHaveLength(2);
  });

  it("renders distinct speakers from the persisted transcript row", () => {
    const request = buildRenderTranscriptRequestFromRows([
      {
        started_at: 0,
        words: JSON.parse(String(transcriptStatement?.params[4])),
        speaker_hints: JSON.parse(String(transcriptStatement?.params[5])),
      },
    ]);

    const words = request?.transcripts[0]?.words ?? [];
    expect(words.map((word) => word.speaker_index)).toEqual([0, 1, 0, null]);
    expect(request?.transcripts[0]?.assignments).toEqual([
      {
        human_id: "import-speaker:marwane lairi",
        scope: {
          kind: "channel_speaker",
          channel: "DirectMic",
          speaker_index: 0,
        },
      },
      {
        human_id: "import-speaker:ayman berriga",
        scope: {
          kind: "channel_speaker",
          channel: "DirectMic",
          speaker_index: 1,
        },
      },
    ]);
  });
});

describe("imported summaries", () => {
  const documentStatements = (summaryMarkdown: string) =>
    buildMeetingStatements({
      providerId: "fireflies",
      sourcePath: "/exports/three/transcript.json",
      sessionId: "33333333-3333-4333-8333-333333333333",
      importKey: "fireflies:external-three",
      meeting: {
        externalId: "external-three",
        title: "Roadmap",
        startedAt: "2026-09-01T09:00:00.000Z",
        endedAt: "2026-09-01T10:00:00.000Z",
        sourceUrl: "https://fireflies.ai/view/three",
        noteMarkdown: "My own notes.",
        summaryMarkdown,
        transcript: [],
        attendees: [],
        actionItems: [],
      },
    }).filter(({ sql }) => sql.includes("INSERT INTO session_documents"));

  it("keeps the provider summary out of the memo", () => {
    const [note, summary] = documentStatements("Decided to ship.");

    expect(note?.sql).toContain("'note'");
    expect(String(note?.params[2])).toContain("My own notes.");
    expect(summary?.sql).toContain("'summary'");
    expect(String(summary?.params[1])).toContain("Decided to ship.");
    expect(summary?.params[0]).toBe(
      "33333333-3333-4333-8333-333333333333:summary",
    );
  });

  it("records the import key so a re-import matches the UUID session", () => {
    const [session] = buildMeetingStatements({
      providerId: "fireflies",
      sourcePath: "/exports/three/transcript.json",
      sessionId: "33333333-3333-4333-8333-333333333333",
      importKey: "fireflies:external-three",
      meeting: {
        externalId: "external-three",
        title: "Roadmap",
        startedAt: "",
        endedAt: "",
        sourceUrl: "",
        noteMarkdown: "",
        summaryMarkdown: "",
        transcript: [],
        attendees: [],
        actionItems: [],
      },
    });

    expect(JSON.parse(String(session?.params[9]))).toMatchObject({
      importKey: "fireflies:external-three",
    });
  });

  it("writes no summary document when the export has none", () => {
    expect(documentStatements("")).toHaveLength(1);
  });
});

describe("prior import reuse", () => {
  it("skips a file that already landed its meetings", () => {
    expect(
      isPriorImportSettled({ discovered_count: 3, settled_target_count: 3 }),
    ).toBe(true);
  });

  it("retries a file whose meetings only ever conflicted", () => {
    expect(
      isPriorImportSettled({ discovered_count: 3, settled_target_count: 0 }),
    ).toBe(false);
  });
});
