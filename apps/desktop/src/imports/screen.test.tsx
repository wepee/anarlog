import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  detectImportSources: vi.fn(),
  cancelConnectedImport: vi.fn(),
  connectConnectedImport: vi.fn(),
  connectNangoImport: vi.fn(),
  disconnectConnectedImport: vi.fn(),
  disconnectNangoImport: vi.fn(),
  sync: vi.fn(),
  selectFiles: vi.fn(),
  readTextFiles: vi.fn(),
  importMeetingFiles: vi.fn(),
  signIn: vi.fn(),
  signedIn: true,
  connections: [] as Array<{
    connection_id: string;
    integration_id: string;
    status?: string | null;
  }>,
}));

vi.mock("~/auth", () => ({
  useAuth: () => ({
    session: mocks.signedIn ? { user: { id: "user-1" } } : null,
    signIn: mocks.signIn,
    getHeaders: () =>
      mocks.signedIn ? { Authorization: "Bearer test" } : null,
  }),
}));

vi.mock("~/auth/useConnections", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  return {
    useConnections: () =>
      useQuery({
        queryKey: ["integration-status", "user-1"],
        queryFn: async () => mocks.connections,
        initialData: mocks.connections,
      }),
  };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.selectFiles }));
vi.mock("@anlg/plugin-importer", () => ({
  commands: { readTextFiles: mocks.readTextFiles },
}));

vi.mock("./detection", () => ({
  detectImportSources: mocks.detectImportSources,
}));

vi.mock("./queries", () => ({
  EMPTY_MEETING_IMPORT_HISTORY: [],
  importConnectedMeetings: vi.fn(),
  importFirefliesExportBundles: vi.fn(),
  importMeetingFiles: vi.fn(),
  useMeetingImportHistory: () => ({ data: [] }),
}));

vi.mock("./fireflies-export", () => ({
  loadFirefliesExportBundles: vi.fn(),
}));

vi.mock("./connected-import", () => ({
  cancelConnectedImport: mocks.cancelConnectedImport,
  connectConnectedImport: mocks.connectConnectedImport,
  connectNangoImport: mocks.connectNangoImport,
  disconnectConnectedImport: mocks.disconnectConnectedImport,
  disconnectNangoImport: mocks.disconnectNangoImport,
  isDirectMeetingImport: (provider: { directImport?: string }) =>
    Boolean(provider.directImport),
  isNangoMeetingImport: (provider: { directImport?: string }) =>
    provider.directImport === "nango-oauth",
  isLocalConnectedImport: (provider: { directImport?: string }) =>
    provider.directImport === "mcp-oauth" || provider.directImport === "cli",
  nangoConnectionIsReady: (
    connection: { status?: string | null } | undefined,
  ) => Boolean(connection) && connection?.status !== "reconnect_required",
  connectedImportCredentialsQueryKey: (providerId: string) => [
    "meeting-import",
    providerId,
    "credentials",
  ],
  connectedImportSyncQueryKey: (providerId: string) => [
    "meeting-import",
    providerId,
    "sync",
  ],
  connectedImportCredentialsQueryOptions: (providerId: string) => ({
    queryKey: ["meeting-import", providerId, "credentials"],
    queryFn: async () => null,
    staleTime: Infinity,
  }),
  connectedImportSyncQueryOptions: (
    provider: { id: string },
    enabled: boolean,
  ) => ({
    queryKey: ["meeting-import", provider.id, "sync"],
    queryFn: async () => ({
      result: {
        discovered: 0,
        imported: 0,
        matched: 0,
        conflicts: 0,
        errors: 0,
      },
      warnings: [],
    }),
    enabled,
    retry: false,
  }),
  nangoImportSyncQueryOptions: (
    provider: { id: string },
    connectionId: string | undefined,
    _headers: Record<string, string> | null,
    enabled: boolean,
  ) => ({
    queryKey: ["meeting-import", provider.id, "sync", connectionId],
    queryFn: () => mocks.sync(provider.id),
    enabled,
    retry: false,
  }),
}));

import { MEETING_IMPORT_PROVIDERS } from "./providers";
import { MeetingImportScreen } from "./screen";

function renderImports(
  props: {
    compact?: boolean;
    onNoSourcesDetected?: () => void;
    secondaryAction?: ReactNode;
  } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MeetingImportScreen {...props} />
    </QueryClientProvider>,
  );
}

function mockDetected(ids: string[]) {
  mocks.detectImportSources.mockResolvedValue(
    MEETING_IMPORT_PROVIDERS.filter((provider) =>
      ids.includes(provider.id),
    ).map((provider) => ({
      ...provider,
      installedAppId: `app.${provider.id}`,
      iconUrl: `data:image/png;base64,${provider.id}`,
    })),
  );
}

describe("MeetingImportScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectFiles.mockResolvedValue(["export.json"]);
    mocks.readTextFiles.mockResolvedValue({ status: "ok", data: [] });
    mocks.signedIn = true;
    mocks.connections = [];
    mocks.sync.mockResolvedValue({
      result: {
        discovered: 0,
        imported: 0,
        matched: 0,
        conflicts: 0,
        errors: 0,
      },
      warnings: [],
    });
    mocks.cancelConnectedImport.mockResolvedValue(true);
    mocks.connectNangoImport.mockResolvedValue({
      connection_id: "zoom-1",
      integration_id: "zoom",
    });
    mocks.signIn.mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  it("lists only detected apps", async () => {
    mockDetected([
      "chatgpt-record",
      "circleback",
      "granola",
      "slack-huddles",
      "zoom",
    ]);

    renderImports();

    expect(await screen.findByText("ChatGPT Record")).toBeTruthy();
    expect(screen.getByText("Circleback")).toBeTruthy();
    expect(screen.getByText("Granola")).toBeTruthy();
    expect(screen.getByText("Slack Huddles")).toBeTruthy();
    expect(screen.getByText("Zoom")).toBeTruthy();
    expect(screen.queryByText("Avoma")).toBeNull();
    expect(screen.queryByText("Fireflies.ai")).toBeNull();
    expect(screen.queryByText("Krisp")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Connect" })).toHaveLength(3);
  });

  it("offers file import from the connected provider menu", async () => {
    mockDetected(["granola"]);

    renderImports();

    const trigger = await screen.findByRole("button", {
      name: "Use files",
    });
    fireEvent.pointerDown(trigger);

    expect(
      await screen.findByRole("menuitem", { name: "Use files" }),
    ).toBeTruthy();
  });

  it("offers a local export folder import for Fireflies", async () => {
    mockDetected(["fireflies", "granola"]);

    renderImports();

    await screen.findByText("Fireflies.ai");
    expect(
      screen.getByRole("button", { name: "Import export folder" }),
    ).toBeTruthy();
    expect(
      screen.queryAllByRole("button", { name: "Import export folder" }),
    ).toHaveLength(1);
  });

  it("lets the user cancel an abandoned browser connection and retry", async () => {
    mockDetected(["granola"]);
    mocks.connectConnectedImport.mockImplementation(
      (_provider: unknown, signal: AbortSignal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );

    renderImports();

    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    const cancelButton = await screen.findByRole("button", { name: "Cancel" });
    fireEvent.click(cancelButton);

    await waitFor(() => {
      expect(mocks.cancelConnectedImport.mock.calls[0]?.[0]).toBe("granola");
      expect(
        screen
          .getByRole("button", { name: "Connect" })
          .hasAttribute("disabled"),
      ).toBe(false);
    });

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => {
      expect(mocks.connectConnectedImport).toHaveBeenCalledTimes(2);
    });
  });

  it("connects Plaud by running the local CLI instead of file-only import", async () => {
    mockDetected(["plaud"]);
    mocks.connectConnectedImport.mockResolvedValue({
      providerId: "plaud",
      clientId: "ada@example.com",
      tokenJson: "{}",
    });

    renderImports();

    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(mocks.connectConnectedImport).toHaveBeenCalledOnce();
    });
    expect(mocks.connectNangoImport).not.toHaveBeenCalled();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(
      screen.queryByText(/Direct connection is not available yet/i),
    ).toBeNull();
  });

  it("connects Pocket through MCP OAuth instead of file-only import", async () => {
    mockDetected(["pocket"]);
    mocks.connectConnectedImport.mockResolvedValue({
      providerId: "pocket",
      clientId: "pocket-client",
      tokenJson: "{}",
    });

    renderImports();

    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(mocks.connectConnectedImport).toHaveBeenCalledOnce();
    });
    expect(mocks.connectNangoImport).not.toHaveBeenCalled();
    expect(screen.getByText("Connected")).toBeTruthy();
  });

  it("reports when detection finishes without finding any apps", async () => {
    const onNoSourcesDetected = vi.fn();
    mockDetected([]);

    renderImports({ onNoSourcesDetected });

    await waitFor(() => {
      expect(onNoSourcesDetected).toHaveBeenCalledOnce();
    });
  });

  it("does not report an empty result while detection is pending", async () => {
    const onNoSourcesDetected = vi.fn();
    mocks.detectImportSources.mockReturnValue(new Promise(() => {}));

    renderImports({ onNoSourcesDetected });

    expect(
      await screen.findByText("Checking installed meeting assistants…"),
    ).toBeTruthy();
    expect(onNoSourcesDetected).not.toHaveBeenCalled();
  });

  it("does not report an empty result when detection fails", async () => {
    const onNoSourcesDetected = vi.fn();
    mocks.detectImportSources.mockRejectedValue(new Error("Detection failed"));

    renderImports({ onNoSourcesDetected });

    expect(await screen.findByText("Detection failed")).toBeTruthy();
    expect(onNoSourcesDetected).not.toHaveBeenCalled();
  });
});
