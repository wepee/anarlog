import { useEffect, useRef } from "react";

import { createLiveAssistEngine } from "./engine";

import { useLiveModel } from "~/ai/hooks";
import { useConfigValue } from "~/shared/config";
import { useLatestRef } from "~/shared/hooks/useLatestRef";

export function LiveAssistHost() {
  const enabled = useConfigValue("live_assist_enabled");
  const language = useConfigValue("ai_language") || "en";
  const spokenLanguages = useConfigValue("spoken_languages");
  const useMainLanguage = useConfigValue("summary_use_main_language");
  const webSearch = useConfigValue("live_assist_web_research");
  const autoAnswers = useConfigValue("live_assist_auto_answers");
  const projectsCommand = useConfigValue("projects_command");
  const live = useLiveModel();
  const model = live?.model ?? null;
  const config = useLatestRef({
    enabled,
    model,
    modelId: live?.modelId ?? "",
    providerId: live?.providerId ?? "",
    language,
    spokenLanguages,
    useMainLanguage,
    webSearch,
    autoAnswers,
    projectsCommand,
  });
  const engineRef = useRef<ReturnType<typeof createLiveAssistEngine> | null>(
    null,
  );

  useEffect(() => {
    const engine = createLiveAssistEngine(() => config.current);
    engineRef.current = engine;
    return () => {
      engineRef.current = null;
      engine.dispose();
    };
  }, [config]);

  // Turning the setting off, or losing the model, stops the current run.
  useEffect(() => {
    engineRef.current?.sync();
  }, [enabled, model]);

  return null;
}
