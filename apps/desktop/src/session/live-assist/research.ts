import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { generateText, type LanguageModel, type ToolSet } from "ai";

import { describeModel } from "./journal";

export const LIVE_ASSIST_MAX_RESEARCH_PER_CALL = 6;
const RESEARCH_TIMEOUT_MS = 30_000;
const MAX_QUERY_WORDS = 6;
const MAX_QUERY_CHARS = 80;
const MAX_SOURCES = 3;

export type LiveAssistResearch = {
  query: string;
  summary: string;
  sources: Array<{ title: string; url: string }>;
};

// Web search runs through the configured provider's own search tool, with
// the user's own key: BlackMushi's hosted search needs a cloud account this
// app does not use. Providers without such a tool simply get no research.
export function getWebSearchTools(model: LanguageModel | null): ToolSet | null {
  const provider = describeModel(model)?.provider ?? "";
  if (provider.startsWith("anthropic")) {
    return { web_search: anthropic.tools.webSearch_20250305({ maxUses: 2 }) };
  }
  if (provider.startsWith("openai.responses")) {
    return { web_search: openai.tools.webSearch({}) };
  }
  if (provider.startsWith("google")) {
    return { google_search: google.tools.googleSearch({}) };
  }
  return null;
}

// Only the name of a company, product, technology or rule ever leaves for a
// search engine: a long query or one that reads like a sentence from the
// call is refused.
export function normalizeResearchQuery(query: string): string | null {
  const cleaned = query
    .replace(/["«»“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length > MAX_QUERY_CHARS) {
    return null;
  }
  if (cleaned.split(" ").length > MAX_QUERY_WORDS || /[?!.:;]/.test(cleaned)) {
    return null;
  }
  return cleaned;
}

export async function runLiveAssistResearch({
  model,
  tools,
  query,
  language,
  signal,
}: {
  model: LanguageModel;
  tools: ToolSet;
  query: string;
  language: string;
  signal?: AbortSignal;
}): Promise<LiveAssistResearch> {
  const result = await generateText({
    model,
    tools,
    system:
      "You look things up for someone in a live business call. Search the web, then answer in at most two short sentences: what it is, and the one or two facts that matter for the conversation. No preamble.",
    prompt: `Look up: ${query}\nAnswer in ${language}.`,
    abortSignal: signal,
    maxRetries: 1,
    maxOutputTokens: 400,
    timeout: { totalMs: RESEARCH_TIMEOUT_MS },
  });

  const sources: LiveAssistResearch["sources"] = [];
  const seen = new Set<string>();
  for (const source of result.sources ?? []) {
    const record = source as { url?: unknown; title?: unknown };
    if (typeof record.url !== "string" || seen.has(record.url)) {
      continue;
    }
    seen.add(record.url);
    sources.push({
      url: record.url,
      title:
        typeof record.title === "string" && record.title.trim()
          ? record.title.trim()
          : new URL(record.url).hostname,
    });
    if (sources.length >= MAX_SOURCES) {
      break;
    }
  }

  return { query, summary: result.text.trim(), sources };
}

export function formatResearchForPrompt(
  research: LiveAssistResearch[],
): string {
  if (research.length === 0) {
    return "(none)";
  }
  return research
    .map((item) =>
      [
        `- ${item.query}: ${item.summary || "(no answer)"}`,
        ...item.sources.map((source) => `  source: ${source.url}`),
      ].join("\n"),
    )
    .join("\n");
}

export function getSourceLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
