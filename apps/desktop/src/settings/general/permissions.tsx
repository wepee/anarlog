import { Trans, useLingui } from "@lingui/react/macro";

import type { PermissionStatus } from "@anlg/plugin-permissions";
import { ArrowRight, Check, WarningCircle } from "@anlg/ui/components/icons";
import { Button } from "@anlg/ui/components/ui/button";
import { useMountEffect } from "@anlg/ui/hooks/use-mount-effect";
import { cn } from "@anlg/utils";

import {
  trackPermissionRequested,
  usePermissionAnalytics,
} from "~/shared/hooks/usePermissionAnalytics";
import {
  closePermissionAssistant,
  usePermission,
  usePermissionGuidance,
} from "~/shared/hooks/usePermissions";

function PermissionRow({
  title,
  description,
  status,
  isPending,
  error,
  permission,
  onRequest,
  onOpen,
  assisted = false,
}: {
  title: string;
  description: string;
  status: PermissionStatus | undefined;
  isPending: boolean;
  error?: string | null;
  permission: string;
  onRequest: () => void;
  onOpen: () => void;
  assisted?: boolean;
}) {
  const { t } = useLingui();
  const isAuthorized = status === "authorized";
  const isDenied = status === "denied";

  const handleButtonClick = () => {
    if (assisted || isAuthorized || isDenied) {
      trackPermissionRequested(permission, status, "settings", "open_settings");
      onOpen();
    } else {
      trackPermissionRequested(permission, status, "settings", "request");
      onRequest();
    }
  };

  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex-1">
        <div
          className={cn([
            "mb-1 flex items-center gap-2",
            !isAuthorized && "text-red-500",
          ])}
        >
          {!isAuthorized && <WarningCircle className="size-4" />}
          <h3 className="text-sm font-medium">{title}</h3>
        </div>
        <p className="text-muted-foreground text-xs">{description}</p>
        {error && (
          <p role="alert" className="mt-1 text-xs text-red-500">
            {error}
          </p>
        )}
      </div>
      <Button
        variant={isAuthorized ? "ghost" : "default"}
        size="icon"
        onClick={handleButtonClick}
        disabled={isPending}
        className={cn([
          "size-8",
          isAuthorized &&
            "text-green-600 hover:bg-transparent hover:text-green-600",
        ])}
        aria-label={
          assisted || isAuthorized || isDenied
            ? t`Open ${title.toLowerCase()} settings`
            : t`Request ${title.toLowerCase()} permission`
        }
      >
        {isAuthorized ? (
          <Check className="size-4" />
        ) : (
          <ArrowRight className="size-5" />
        )}
      </Button>
    </div>
  );
}

function PermissionGroup({
  title,
  children,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="text-muted-foreground mb-3 text-xs font-semibold tracking-wide uppercase">
        {title}
      </h3>
      <div className="flex flex-col gap-4">{children}</div>
    </div>
  );
}

export function Permissions() {
  return <MacOSPermissions />;
}

function AudioPermissions() {
  const { t } = useLingui();
  const mic = usePermission("microphone");
  const systemAudio = usePermission("systemAudio");
  usePermissionAnalytics("microphone", mic.confirmedStatus, "settings");
  usePermissionAnalytics(
    "system_audio",
    systemAudio.confirmedStatus,
    "settings",
  );

  return (
    <PermissionGroup title={<Trans>Audio</Trans>}>
      <PermissionRow
        permission="microphone"
        title={t`Microphone`}
        description={t`Record your voice in meetings and calls.`}
        status={mic.status}
        isPending={mic.isPending}
        error={mic.error}
        onRequest={mic.request}
        onOpen={mic.open}
      />
      <PermissionRow
        permission="system_audio"
        title={t`System audio`}
        description={t`Record other participants in meetings.`}
        status={systemAudio.status}
        isPending={systemAudio.isPending}
        error={systemAudio.error}
        onRequest={systemAudio.request}
        onOpen={systemAudio.open}
      />
    </PermissionGroup>
  );
}

function MacOSPermissions() {
  const { t } = useLingui();
  const calendar = usePermission("calendar");
  const accessibility = usePermission("accessibility");
  const accessibilityGuidance = usePermissionGuidance("accessibility");
  usePermissionAnalytics("calendar", calendar.confirmedStatus, "settings");
  usePermissionAnalytics(
    "accessibility",
    accessibility.confirmedStatus,
    "settings",
  );

  // Leaving settings while the assistant is up would strand its overlay on top
  // of System Settings with nothing left to dismiss it.
  useMountEffect(() => () => void closePermissionAssistant());

  return (
    <div className="flex flex-col gap-8">
      <AudioPermissions />

      <PermissionRow
        permission="accessibility"
        title={t`Accessibility`}
        description={
          accessibilityGuidance
            ? t`Opens System Settings and guides you to add BlackMushi to the ${accessibilityGuidance.paneTitle ?? "Privacy"} list.`
            : t`Read meeting controls and visible chat.`
        }
        status={accessibility.status}
        isPending={accessibility.isPending}
        onRequest={accessibility.request}
        onOpen={accessibility.open}
        assisted={Boolean(accessibilityGuidance)}
      />

      <PermissionGroup title={<Trans>Others</Trans>}>
        <PermissionRow
          permission="calendar"
          title={t`Calendar`}
          description={t`Show Apple Calendar events in BlackMushi.`}
          status={calendar.status}
          isPending={calendar.isPending}
          onRequest={calendar.request}
          onOpen={calendar.open}
        />
      </PermissionGroup>
    </div>
  );
}
