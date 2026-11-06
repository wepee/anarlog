import { convertFileSrc } from "@tauri-apps/api/core";

import { commands as fsSyncCommands } from "@anlg/plugin-fs-sync";

import {
  type EnhanceImageContext,
  getBase64ByteLength,
  prepareImageForBudget,
  prioritizeEvenlySpread,
  readImageAttachment,
} from "./enhance-images";

import { formatMeetingPlatform } from "~/stt/meeting-chat-records";
import type { MeetingScreenRecord } from "~/stt/meeting-screen-records";

export type MeetingScreenReference = {
  ref: string;
  attachmentId: string;
  src: string;
};

type JsonNode = {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
};

const MAX_SCREEN_IMAGE_COUNT = 12;
const MAX_SCREEN_IMAGE_BYTES = 128 * 1024;
const MAX_TOTAL_SCREEN_IMAGE_BYTES = 1280 * 1024;
export const MAX_EMBEDDED_SCREEN_COUNT = 6;

const SCREEN_SRC_PREFIX = "screen:";
const SCREEN_IMAGE_MARKDOWN_RE = /!\[[^\]\n]*\]\(screen:[^)\n]*\)?/g;

// Refs follow the capture order of the whole session, not the sampled subset,
// so they stay stable whichever captures fit the budget.
export function meetingScreenRef(index: number): string {
  return `S${index + 1}`;
}

export async function collectMeetingScreenContext({
  sessionId,
  records,
  recordingStartedAt,
}: {
  sessionId: string;
  records: MeetingScreenRecord[];
  recordingStartedAt: number | null;
}): Promise<{
  images: EnhanceImageContext[];
  screens: MeetingScreenReference[];
}> {
  if (records.length === 0) {
    return { images: [], screens: [] };
  }

  const listResult = await fsSyncCommands.attachmentList(sessionId);
  if (listResult.status === "error") {
    console.warn(
      "[enhance] failed to list shared screen attachments",
      listResult.error,
    );
    return { images: [], screens: [] };
  }
  const attachments = new Map(
    listResult.data.map((attachment) => [attachment.attachmentId, attachment]),
  );

  const indexed = records.map((record, index) => ({ record, index }));
  const selected: Array<{
    index: number;
    image: EnhanceImageContext;
    screen: MeetingScreenReference;
  }> = [];
  let totalBytes = 0;

  for (const { record, index } of prioritizeEvenlySpread(
    indexed,
    MAX_SCREEN_IMAGE_COUNT,
  )) {
    const attachment = attachments.get(record.attachmentId);
    if (!attachment) {
      continue;
    }

    const source = await readImageAttachment(sessionId, attachment);
    if (!source) {
      continue;
    }

    const image = await prepareImageForBudget(source, {
      maxImageBytes: MAX_SCREEN_IMAGE_BYTES,
      remainingBytes: MAX_TOTAL_SCREEN_IMAGE_BYTES - totalBytes,
    });
    if (!image) {
      continue;
    }

    const ref = meetingScreenRef(index);
    totalBytes += getBase64ByteLength(image.base64);
    selected.push({
      index,
      image: {
        ...image,
        label: formatMeetingScreenLabel(ref, record, recordingStartedAt),
      },
      screen: {
        ref,
        attachmentId: record.attachmentId,
        src: convertFileSrc(attachment.path),
      },
    });
    if (selected.length >= MAX_SCREEN_IMAGE_COUNT) {
      break;
    }
  }

  selected.sort((a, b) => a.index - b.index);
  return {
    images: selected.map(({ image }) => image),
    screens: selected.map(({ screen }) => screen),
  };
}

export function formatMeetingScreenLabel(
  ref: string,
  record: Pick<MeetingScreenRecord, "capturedAt" | "platform">,
  recordingStartedAt: number | null,
): string {
  const capturedAt = Date.parse(record.capturedAt);
  const source = record.platform
    ? `${formatMeetingPlatform(record.platform as never)} shared screen`
    : "Shared screen";

  if (
    recordingStartedAt !== null &&
    Number.isFinite(capturedAt) &&
    capturedAt >= recordingStartedAt
  ) {
    // Same [MM:SS] clock as the transcript lines, so the model can line the
    // capture up with what was being said.
    const offsetMs = capturedAt - recordingStartedAt;
    const minutes = Math.floor(offsetMs / 60_000);
    const seconds = Math.floor(offsetMs / 1000) % 60;
    const clock = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    return `[${ref}] ${source}, appeared at [${clock}] in the transcript:`;
  }

  return `[${ref}] ${source}:`;
}

export function formatMeetingScreenPromptNote(
  screens: MeetingScreenReference[],
): string {
  if (screens.length === 0) {
    return "";
  }

  const example = screens[0].ref;
  return [
    "Screens shared during the meeting are attached, each preceded by its reference and the transcript time it appeared at.",
    "Read them as part of the meeting: use slide text, figures, tables, and documents to make the summary accurate and complete, and match each screen with what was said around that time.",
    `When a screen shows something the summary should keep visually (a chart, diagram, table, or key slide), embed it on its own line right after the related content, using exactly \`![short caption](screen:${example})\` with that screen's reference.`,
    `Embed at most ${MAX_EMBEDDED_SCREEN_COUNT} screens, only those that add information beyond the text, never inside headings, and only the references listed here.`,
  ].join(" ");
}

export function embedMeetingScreens<T>(
  doc: T,
  screens: MeetingScreenReference[],
): T {
  const byRef = new Map(screens.map((screen) => [screen.ref, screen]));
  const embedded = new Set<string>();

  function visit(node: JsonNode): JsonNode | null {
    if (node.type === "image") {
      const src = typeof node.attrs?.src === "string" ? node.attrs.src : "";
      if (!src.startsWith(SCREEN_SRC_PREFIX)) {
        return node;
      }

      const screen = byRef.get(src.slice(SCREEN_SRC_PREFIX.length).trim());
      if (
        !screen ||
        embedded.has(screen.ref) ||
        embedded.size >= MAX_EMBEDDED_SCREEN_COUNT
      ) {
        return null;
      }

      embedded.add(screen.ref);
      return {
        ...node,
        attrs: {
          ...node.attrs,
          src: screen.src,
          attachmentId: screen.attachmentId,
        },
      };
    }

    if (!node.content) {
      return node;
    }

    return {
      ...node,
      content: node.content.flatMap((child) => {
        const next = visit(child);
        return next ? [next] : [];
      }),
    };
  }

  return (visit(doc as JsonNode) ?? doc) as T;
}

export function stripMeetingScreenImages(markdown: string): string {
  return markdown.replace(SCREEN_IMAGE_MARKDOWN_RE, "");
}
