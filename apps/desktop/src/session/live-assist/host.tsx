import { useEffect, useRef } from "react";

import { createLiveAssistEngine } from "./engine";

import { useLanguageModel } from "~/ai/hooks";
import { useConfigValue } from "~/shared/config";
import { useLatestRef } from "~/shared/hooks/useLatestRef";

export function LiveAssistHost() {
  const enabled = useConfigValue("live_assist_enabled");
  const language = useConfigValue("ai_language") || "en";
  const model = useLanguageModel("chat");
  const config = useLatestRef({ enabled, model, language });
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
