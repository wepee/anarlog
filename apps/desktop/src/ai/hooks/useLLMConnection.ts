import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  defaultSettingsMiddleware,
  extractReasoningMiddleware,
  wrapLanguageModel,
} from "ai";
import { useMemo } from "react";

import type { CharTask } from "@anlg/api-client";
import type { AIProviderStorage } from "@anlg/store";

import { createAppleFoundationModel } from "../apple-foundation-model";
import { providerFetch } from "../provider-fetch";
import {
  normalizeReasoningEffort,
  type ReasoningEffort,
  reasoningProviderOptions,
} from "../reasoning-effort";
import { streamOnlyGenerationMiddleware } from "../stream-only-generation";
import { createTracedFetch, tracedFetch } from "../traced-fetch";

import { env } from "~/env";
import { type ProviderId, PROVIDERS } from "~/settings/ai/llm/shared";
import {
  CHATGPT_API_BASE_URL,
  createSubscriptionFetch,
  usesSubscriptionFetch,
} from "~/settings/ai/llm/subscriptions";
import {
  getProviderSelectionBlockers,
  type ProviderEligibilityContext,
} from "~/settings/ai/shared/eligibility";
import { useAiProvider } from "~/settings/providers";
import { useSettingsReady } from "~/settings/queries";
import { useConfigValues } from "~/shared/config";

// App attribution per https://openrouter.ai/docs/app-attribution. Mirrors
// crates/llm-proxy/src/provider/openrouter.rs's APP_REFERER/APP_TITLE/
// APP_CATEGORIES, which only cover the "anarlog" hosted-provider case (it
// routes through apps/api's llm-proxy); this BYOK "openrouter" case talks to
// openrouter.ai directly from the client and needs its own headers.
const OPENROUTER_APP_URL = "https://anarlog.so";
const OPENROUTER_APP_NAME = "BlackMushi";
const OPENROUTER_APP_CATEGORIES = "writing-assistant,personal-agent";

type LanguageModelV3 = Parameters<typeof wrapLanguageModel>[0]["model"];

type LLMConnectionInfo = {
  providerId: ProviderId;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  reasoningEffort: ReasoningEffort;
};

export type LLMConnectionStatus =
  | { status: "pending"; reason: "managed_disabled" | "settings_loading" }
  | { status: "pending"; reason: "missing_provider" }
  | { status: "pending"; reason: "missing_model"; providerId: ProviderId }
  | { status: "error"; reason: "provider_not_found"; providerId: string }
  | { status: "error"; reason: "unauthenticated"; providerId: "anarlog" }
  | { status: "error"; reason: "not_pro"; providerId: "anarlog" }
  | {
      status: "error";
      reason: "missing_config";
      providerId: ProviderId;
      missing: Array<"base_url" | "api_key">;
    }
  | { status: "success"; providerId: ProviderId; isHosted: boolean };

type LLMConnectionResult = {
  conn: LLMConnectionInfo | null;
  status: LLMConnectionStatus;
};

export const normalizeLLMProviderId = (providerId: string): string =>
  providerId === "hyprnote" ? "anarlog" : providerId;

export const useLanguageModel = (task?: CharTask): LanguageModelV3 | null => {
  const { conn } = useLLMConnection();
  return useMemo(() => {
    if (!conn) return null;

    return createLanguageModel(conn, task);
  }, [conn, task]);
};

// What runs during a call (Live Assist, live answers) has to answer within
// seconds, so it can use its own model while summaries keep the main one.
// Without a choice, the provider's fast model is used when it has one.
const FAST_LIVE_MODELS: Partial<Record<string, string>> = {
  anthropic: "claude-haiku-5-5",
  claude: "claude-haiku-5-5",
};

export function resolveLiveModelId({
  providerId,
  mainModelId,
  liveProviderId,
  liveModelId,
}: {
  providerId: string;
  mainModelId: string;
  liveProviderId: string | undefined;
  liveModelId: string | undefined;
}): string {
  if (liveModelId && liveProviderId === providerId) {
    return liveModelId;
  }
  return FAST_LIVE_MODELS[providerId] ?? mainModelId;
}

export const useLiveModel = (): {
  model: LanguageModelV3;
  modelId: string;
  providerId: string;
} | null => {
  const { conn } = useLLMConnection();
  const { live_llm_provider, live_llm_model } = useConfigValues([
    "live_llm_provider",
    "live_llm_model",
  ] as const);
  return useMemo(() => {
    if (!conn) return null;
    const modelId = resolveLiveModelId({
      providerId: conn.providerId,
      mainModelId: conn.modelId,
      liveProviderId: live_llm_provider,
      liveModelId: live_llm_model,
    });
    const liveConn =
      modelId === conn.modelId
        ? conn
        : { ...conn, modelId, reasoningEffort: "default" as const };
    return {
      model: createLanguageModel(liveConn, "chat"),
      modelId,
      providerId: liveConn.providerId,
    };
  }, [conn, live_llm_provider, live_llm_model]);
};

export const useLLMConnection = (): LLMConnectionResult => {
  const settingsReady = useSettingsReady();

  const {
    intelligence_disabled,
    current_llm_provider,
    current_llm_model,
    current_llm_reasoning_effort,
  } = useConfigValues([
    "intelligence_disabled",
    "current_llm_provider",
    "current_llm_model",
    "current_llm_reasoning_effort",
  ] as const);
  const providerConfig = useAiProvider("llm", current_llm_provider) as
    | AIProviderStorage
    | undefined;

  return useMemo<LLMConnectionResult>(
    () =>
      !settingsReady || intelligence_disabled
        ? {
            conn: null,
            status: {
              status: "pending",
              reason: intelligence_disabled
                ? "managed_disabled"
                : "settings_loading",
            },
          }
        : resolveLLMConnection({
            providerId: current_llm_provider,
            modelId: current_llm_model,
            reasoningEffort: normalizeReasoningEffort(
              current_llm_reasoning_effort,
            ),
            providerConfig,
          }),
    [
      settingsReady,
      intelligence_disabled,
      current_llm_model,
      current_llm_provider,
      current_llm_reasoning_effort,
      providerConfig,
    ],
  );
};

export const useLLMConnectionStatus = (): LLMConnectionStatus => {
  const { status } = useLLMConnection();
  return status;
};

const resolveLLMConnection = (params: {
  providerId: string | undefined;
  modelId: string | undefined;
  reasoningEffort: ReasoningEffort;
  providerConfig: AIProviderStorage | undefined;
}): LLMConnectionResult => {
  const {
    providerId: rawProviderId,
    modelId,
    reasoningEffort,
    providerConfig,
  } = params;

  if (!rawProviderId) {
    return {
      conn: null,
      status: { status: "pending", reason: "missing_provider" },
    };
  }

  const providerId = normalizeLLMProviderId(rawProviderId) as ProviderId;

  if (!modelId) {
    return {
      conn: null,
      status: { status: "pending", reason: "missing_model", providerId },
    };
  }

  const providerDefinition = PROVIDERS.find((p) => p.id === providerId);

  if (!providerDefinition) {
    return {
      conn: null,
      status: {
        status: "error",
        reason: "provider_not_found",
        providerId: rawProviderId,
      },
    };
  }

  const baseUrl =
    providerConfig?.base_url?.trim() ||
    providerDefinition.baseUrl?.trim() ||
    "";
  const apiKey = providerConfig?.api_key?.trim() || "";

  const context: ProviderEligibilityContext = {
    config: { base_url: baseUrl, api_key: apiKey },
  };

  const blockers = getProviderSelectionBlockers(
    providerDefinition.requirements,
    context,
  );

  if (blockers.length > 0) {
    const blocker = blockers[0];
    if (blocker.code === "missing_config") {
      return {
        conn: null,
        status: {
          status: "error",
          reason: "missing_config",
          providerId,
          missing: blocker.fields,
        },
      };
    }
  }

  if (providerId === "anarlog" && apiKey) {
    return {
      conn: {
        providerId,
        modelId,
        baseUrl: baseUrl ?? new URL("/llm", env.VITE_API_URL).toString(),
        apiKey,
        reasoningEffort,
      },
      status: { status: "success", providerId, isHosted: true },
    };
  }

  return {
    conn: { providerId, modelId, baseUrl, apiKey, reasoningEffort },
    status: { status: "success", providerId, isHosted: false },
  };
};

const wrapWithThinkingMiddleware = (
  model: LanguageModelV3,
): LanguageModelV3 => {
  return wrapLanguageModel({
    model,
    middleware: [
      extractReasoningMiddleware({ tagName: "think" }),
      extractReasoningMiddleware({ tagName: "thinking" }),
    ],
  });
};

const createLanguageModel = (
  conn: LLMConnectionInfo,
  task?: CharTask,
  hostedFetch?: typeof fetch,
): LanguageModelV3 => {
  const model = createProviderModel(conn, task, hostedFetch);
  const providerOptions = reasoningProviderOptions(
    conn.providerId,
    conn.modelId,
    conn.reasoningEffort,
  );
  if (!providerOptions) {
    return model;
  }

  return wrapLanguageModel({
    model,
    middleware: defaultSettingsMiddleware({ settings: { providerOptions } }),
  });
};

const createProviderModel = (
  conn: LLMConnectionInfo,
  task?: CharTask,
  hostedFetch?: typeof fetch,
): LanguageModelV3 => {
  switch (conn.providerId) {
    case "anarlog": {
      const provider = createOpenRouter({
        fetch: hostedFetch ?? (task ? createTracedFetch(task) : tracedFetch),
        baseURL: conn.baseUrl,
        apiKey: conn.apiKey,
      });
      return wrapWithThinkingMiddleware(provider.chat(conn.modelId));
    }

    case "anthropic": {
      const provider = createAnthropic({
        fetch: providerFetch,
        apiKey: conn.apiKey,
        headers: {
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
      });
      return wrapWithThinkingMiddleware(provider(conn.modelId));
    }

    case "claude": {
      const oauth = usesSubscriptionFetch(conn.providerId, conn.apiKey);
      const provider = createAnthropic({
        fetch: oauth
          ? createSubscriptionFetch(conn.providerId, conn.apiKey)
          : providerFetch,
        apiKey: oauth ? "oauth" : conn.apiKey,
        headers: {
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
      });
      return wrapWithThinkingMiddleware(provider(conn.modelId));
    }

    case "chatgpt": {
      const oauth = usesSubscriptionFetch(conn.providerId, conn.apiKey);
      const provider = createOpenAI({
        fetch: oauth
          ? createSubscriptionFetch(conn.providerId, conn.apiKey)
          : providerFetch,
        baseURL: oauth ? CHATGPT_API_BASE_URL : conn.baseUrl,
        apiKey: oauth ? "oauth" : conn.apiKey,
      });
      const model = provider.responses(conn.modelId);
      return wrapWithThinkingMiddleware(
        oauth
          ? wrapLanguageModel({
              model,
              middleware: [
                // The SDK must serialize history as stateless before fetch
                // enforces the Codex request contract.
                defaultSettingsMiddleware({
                  settings: { providerOptions: { openai: { store: false } } },
                }),
                streamOnlyGenerationMiddleware,
              ],
            })
          : model,
      );
    }

    case "grok":
    case "github_copilot": {
      const provider = createOpenAICompatible({
        fetch: createSubscriptionFetch(conn.providerId, conn.apiKey),
        name: conn.providerId,
        baseURL: conn.baseUrl,
        apiKey: "oauth",
      });
      return wrapWithThinkingMiddleware(provider.chatModel(conn.modelId));
    }

    case "google_generative_ai": {
      const provider = createGoogleGenerativeAI({
        fetch: providerFetch,
        baseURL: conn.baseUrl,
        apiKey: conn.apiKey,
      });
      return wrapWithThinkingMiddleware(provider(conn.modelId));
    }

    case "openrouter": {
      const provider = createOpenRouter({
        fetch: providerFetch,
        apiKey: conn.apiKey,
        appName: OPENROUTER_APP_NAME,
        appUrl: OPENROUTER_APP_URL,
        headers: { "X-OpenRouter-Categories": OPENROUTER_APP_CATEGORIES },
      });
      return wrapWithThinkingMiddleware(provider.chat(conn.modelId));
    }

    case "openai": {
      const provider = createOpenAI({
        fetch: providerFetch,
        baseURL: conn.baseUrl,
        apiKey: conn.apiKey,
      });
      return wrapWithThinkingMiddleware(provider(conn.modelId));
    }

    case "azure_openai": {
      const provider = createAzure({
        fetch: providerFetch,
        baseURL: conn.baseUrl,
        apiKey: conn.apiKey,
      });
      return wrapWithThinkingMiddleware(provider(conn.modelId));
    }

    case "azure_ai": {
      const provider = createOpenAICompatible({
        fetch: providerFetch,
        name: "azure_ai",
        baseURL: conn.baseUrl,
        apiKey: conn.apiKey,
        headers: { "api-key": conn.apiKey },
      });
      return wrapWithThinkingMiddleware(provider.chatModel(conn.modelId));
    }

    case "ollama": {
      const ollamaOrigin = new URL(conn.baseUrl.replace(/\/v1\/?$/, "")).origin;
      const ollamaFetch: typeof fetch = async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("Origin", ollamaOrigin);
        return providerFetch(input as RequestInfo | URL, {
          ...init,
          headers,
        });
      };
      const provider = createOpenAICompatible({
        fetch: ollamaFetch,
        name: conn.providerId,
        baseURL: conn.baseUrl,
      });
      return wrapWithThinkingMiddleware(provider.chatModel(conn.modelId));
    }

    case "apple_foundation":
      return createAppleFoundationModel(conn.modelId);

    default: {
      const config: Parameters<typeof createOpenAICompatible>[0] = {
        fetch: providerFetch,
        name: conn.providerId,
        baseURL: conn.baseUrl,
      };
      if (conn.apiKey) {
        config.apiKey = conn.apiKey;
      }
      const provider = createOpenAICompatible(config);
      return wrapWithThinkingMiddleware(provider.chatModel(conn.modelId));
    }
  }
};
