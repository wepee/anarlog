import { generateId, type LanguageModel, streamText } from "ai";

import { commands as templateCommands } from "@anlg/plugin-template";

import type { TaskArgsMapTransformed, TaskConfig } from ".";
import { appendPreferredNamesGuidance } from "./preferred-names";

const AI_GENERATION_MAX_RETRIES = 4;
// Reasoning models spend thinking tokens from this budget before emitting the
// title; a title-sized cap stops the stream mid-word and persists the fragment.
const TITLE_MAX_OUTPUT_TOKENS = 2_048;

export const titleWorkflow: Pick<
  TaskConfig<"title">,
  "executeWorkflow" | "transforms"
> = {
  executeWorkflow,
  transforms: [],
};

async function* executeWorkflow(params: {
  model: LanguageModel;
  args: TaskArgsMapTransformed["title"];
  onProgress: (step: any) => void;
  signal: AbortSignal;
}) {
  const { model, args, onProgress, signal } = params;

  const system = await getSystemPrompt(args);
  const prompt = await getUserPrompt(args);

  onProgress({ type: "generating" });

  const id = generateId();
  const result = streamText({
    model,
    system,
    prompt,
    abortSignal: signal,
    maxRetries: AI_GENERATION_MAX_RETRIES,
    maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
  });

  for await (const chunk of result.textStream) {
    yield {
      type: "text-delta" as const,
      id,
      text: chunk,
    };
  }

  // A truncated title is worse than none: it would be persisted as the session
  // title and written into the summary heading, cut off mid-word.
  if ((await result.finishReason) === "length") {
    throw new Error("Title generation was cut off before it completed.");
  }
}

async function getSystemPrompt(args: TaskArgsMapTransformed["title"]) {
  const result = await templateCommands.render({
    titleSystem: {
      language: args.language,
    },
  });

  if (result.status === "error") {
    throw new Error(result.error);
  }

  return appendPreferredNamesGuidance(result.data, args.dictionaryTerms);
}

async function getUserPrompt(args: TaskArgsMapTransformed["title"]) {
  const { enhancedNote } = args;

  const result = await templateCommands.render({
    titleUser: {
      enhancedNote,
    },
  });

  if (result.status === "error") {
    throw new Error(result.error);
  }

  return result.data;
}
