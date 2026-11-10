import type { LanguageModel } from "ai";

import { hydrateSessionContext } from "~/chat/context/session-context-hydrator";
import { describeError, liveAssistLog } from "~/session/live-assist/journal";
import {
  type CallTemplateCandidate,
  detectCallTemplate,
} from "~/templates/detect";
import { listUserTemplates } from "~/templates/queries";

const detections = new Map<string, Promise<string | null>>();

export async function listTemplateCandidates(): Promise<
  CallTemplateCandidate[]
> {
  const templates = await listUserTemplates();
  return templates.map((template) => ({
    id: template.id,
    title: template.title,
    description: template.description,
    sections: template.sections.map((section) => section.title),
    sectionDescriptions: template.sections.map(
      (section) => section.description,
    ),
    targets: template.targets ?? [],
  }));
}

// Picks the template for a summary when nothing explicit was asked for:
// a detection on the whole transcript once the call is over (backed by a
// quoted sentence), and otherwise the default template from the settings. The note's starting template plays no part:
// a note that starts recording is always empty.
export async function resolveAutoTemplateId({
  sessionId,
  model,
  defaultTemplateId,
}: {
  sessionId: string;
  model: LanguageModel | null;
  defaultTemplateId: string | undefined;
}): Promise<string | undefined> {
  if (!model) {
    liveAssistLog(
      "summary.template_resolved",
      { source: "default", reason: "no_model", templateId: defaultTemplateId },
      sessionId,
    );
    return defaultTemplateId;
  }

  let detection = detections.get(sessionId);
  if (!detection) {
    detection = detectForSession(sessionId, model).catch((error) => {
      console.error("[enhancer] template detection failed", error);
      liveAssistLog(
        "summary.detection_failed",
        describeError(error),
        sessionId,
      );
      return null;
    });
    detections.set(sessionId, detection);
  }

  const detected = await detection;
  liveAssistLog(
    "summary.template_resolved",
    detected
      ? { source: "detected", templateId: detected }
      : { source: "default", templateId: defaultTemplateId },
    sessionId,
  );
  return detected ?? defaultTemplateId;
}

async function detectForSession(
  sessionId: string,
  model: LanguageModel,
): Promise<string | null> {
  const [context, candidates] = await Promise.all([
    hydrateSessionContext(sessionId),
    listTemplateCandidates(),
  ]);
  const transcript = (context?.transcript?.segments ?? [])
    .map((segment) => `${segment.speaker}: ${segment.text}`.trim())
    .join("\n");

  const title = context?.event?.name ?? context?.title ?? null;
  const startedAt = Date.now();
  const result = await detectCallTemplate({
    model,
    title,
    participants: (context?.participants ?? []).map(
      (participant) => participant.name,
    ),
    transcript,
    candidates,
  });
  liveAssistLog(
    "summary.detection",
    {
      durationMs: Date.now() - startedAt,
      title,
      transcriptChars: transcript.length,
      sampledChars: result.sampledChars,
      candidates: candidates.map(({ id, title }) => ({ id, title })),
      proposal: result.proposal,
      outcome: result.reason,
      templateId: result.templateId,
    },
    sessionId,
  );
  return result.templateId;
}
