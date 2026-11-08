import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import type { LanguageModel, ToolSet } from "ai";

import { describeModel } from "./journal";

// Live answers may search the web through the configured provider's own
// search tool, with the user's own key; the model decides when a question
// needs it. Providers without such a tool simply answer without the web.
export function getWebSearchTools(model: LanguageModel | null): ToolSet | null {
  const provider = describeModel(model)?.provider ?? "";
  if (provider.startsWith("anthropic")) {
    return { web_search: anthropic.tools.webSearch_20250305({ maxUses: 1 }) };
  }
  if (provider.startsWith("openai.responses")) {
    return { web_search: openai.tools.webSearch({}) };
  }
  if (provider.startsWith("google")) {
    return { google_search: google.tools.googleSearch({}) };
  }
  return null;
}

export function getSourceLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
