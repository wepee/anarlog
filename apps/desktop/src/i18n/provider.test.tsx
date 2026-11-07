import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  values: { ai_language: "fr", app_language: "" } as Record<string, string>,
}));

vi.mock("~/shared/config", () => ({
  useConfigValue: (key: string) => mocks.values[key],
}));

import { AppI18nProvider } from "./provider";

function renderProvider() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AppI18nProvider>
        <span />
      </AppI18nProvider>
    </QueryClientProvider>,
  );
}

describe("AppI18nProvider", () => {
  afterEach(() => {
    cleanup();
  });

  it("follows the main language until an app language is picked", async () => {
    renderProvider();
    await waitFor(() => expect(document.documentElement.lang).toBe("fr"));
    cleanup();

    mocks.values = { ai_language: "fr", app_language: "en" };
    renderProvider();
    await waitFor(() => expect(document.documentElement.lang).toBe("en"));
  });
});
