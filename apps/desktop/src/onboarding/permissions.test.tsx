import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const createPermission = () => ({
    status: "denied" as "authorized" | "denied" | "neverRequested",
    confirmedStatus: "denied" as "authorized" | "denied" | "neverRequested",
    isPending: false,
    open: vi.fn(),
    request: vi.fn(),
    reset: vi.fn(),
    error: null as string | null,
  });
  const permissions = {
    microphone: createPermission(),
    systemAudio: createPermission(),
    accessibility: createPermission(),
  };

  return {
    permissions,
    guidance: null as { assisted: boolean; paneTitle: string | null } | null,
    usePermission: vi.fn((type: keyof typeof permissions) => permissions[type]),
    closePermissionAssistant: vi.fn(),
  };
});

const lingui = vi.hoisted(() => ({
  t: (input: TemplateStringsArray, ...values: unknown[]) =>
    input.reduce(
      (message, part, index) =>
        `${message}${part}${index < values.length ? String(values[index]) : ""}`,
      "",
    ),
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: lingui.t }),
}));

vi.mock("~/shared/hooks/usePermissions", () => ({
  usePermission: mocks.usePermission,
  usePermissionGuidance: () => mocks.guidance,
  closePermissionAssistant: mocks.closePermissionAssistant,
}));

import { PermissionsSection } from "./permissions";

afterEach(cleanup);

describe("PermissionsSection", () => {
  beforeEach(() => {
    mocks.guidance = null;
    vi.clearAllMocks();

    Object.values(mocks.permissions).forEach((permission) => {
      permission.status = "denied";
      permission.isPending = false;
      permission.error = null;
    });
  });

  it("waits for all three macOS permissions before continuing", () => {
    const onContinue = vi.fn();
    mocks.permissions.microphone.status = "authorized";
    mocks.permissions.systemAudio.status = "authorized";

    const view = render(<PermissionsSection onContinue={onContinue} />);

    expect(onContinue).not.toHaveBeenCalled();

    mocks.permissions.accessibility.status = "authorized";
    view.rerender(<PermissionsSection onContinue={onContinue} />);

    expect(onContinue).toHaveBeenCalledTimes(1);

    view.rerender(<PermissionsSection onContinue={onContinue} />);

    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("requests denied Accessibility permission instead of opening Settings", () => {
    render(<PermissionsSection />);

    fireEvent.click(
      screen.getByRole("button", { name: "Enable accessibility" }),
    );

    expect(mocks.permissions.accessibility.request).toHaveBeenCalledTimes(1);
    expect(mocks.permissions.accessibility.open).not.toHaveBeenCalled();
  });

  it("routes an assisted Accessibility pane to the guided flow", () => {
    mocks.guidance = { assisted: true, paneTitle: "Accessibility" };

    render(<PermissionsSection />);

    const row = screen.getByRole("button", {
      name: "Open accessibility settings",
    });
    fireEvent.click(row);

    expect(mocks.permissions.accessibility.open).toHaveBeenCalledTimes(1);
    expect(mocks.permissions.accessibility.request).not.toHaveBeenCalled();
  });

  it("dismisses a lingering assistant when onboarding unmounts", () => {
    mocks.guidance = { assisted: true, paneTitle: "Accessibility" };
    const view = render(<PermissionsSection />);

    expect(mocks.closePermissionAssistant).not.toHaveBeenCalled();

    view.unmount();

    expect(mocks.closePermissionAssistant).toHaveBeenCalledTimes(1);
  });
});
