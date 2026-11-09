import { Trans, useLingui } from "@lingui/react/macro";
import { useMutation, useQuery } from "@tanstack/react-query";
import { homeDir } from "@tauri-apps/api/path";
import { open as selectFolder } from "@tauri-apps/plugin-dialog";

import { commands as openerCommands } from "@anlg/plugin-opener2";
import { CircleNotch, FolderSimple } from "@anlg/ui/components/icons";
import { Button } from "@anlg/ui/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@anlg/ui/components/ui/select";

import { displayPath } from "./storage/path-utils";

import {
  setSettingValue,
  useStoredSettingValuesQuery,
} from "~/settings/queries";
import { SETTING_CONTROL_CLASS, SettingRow } from "~/settings/setting-row";

const ARCHIVE_AFTER_OPTIONS = [
  "immediately",
  "oneDay",
  "threeDays",
  "oneWeek",
  "oneMonth",
] as const;

// [fork] Moves finished recordings off this device. The archiving itself runs
// in the transcription plugin's retention sweep.
export function AudioArchiveRow() {
  const { t } = useLingui();
  const settings = useStoredSettingValuesQuery();
  const directory = settings.data?.values.audio_archive_directory || "";
  const after = settings.data?.values.audio_archive_after || "oneWeek";
  const { data: home } = useQuery({ queryKey: ["home-dir"], queryFn: homeDir });
  const changeMutation = useMutation({
    mutationFn: async (action: "choose" | "stop") => {
      if (action === "stop") {
        await setSettingValue("audio_archive_directory", "");
        return;
      }

      const iCloudDrive = home
        ? `${home}/Library/Mobile Documents/com~apple~CloudDocs`
        : undefined;
      const selected = await selectFolder({
        title: t`Choose where to archive recordings`,
        directory: true,
        multiple: false,
        defaultPath: directory || iCloudDrive,
      });
      if (selected && selected !== directory) {
        await setSettingValue("audio_archive_directory", selected);
      }
    },
  });
  const afterMutation = useMutation({
    mutationFn: (value: string) =>
      setSettingValue("audio_archive_after", value),
  });
  const disabled =
    settings.isLoading || !!settings.error || changeMutation.isPending;
  const copyByValue = {
    immediately: t`Right after the meeting`,
    oneDay: t`After 1 day`,
    threeDays: t`After 3 days`,
    oneWeek: t`After 1 week`,
    oneMonth: t`After 1 month`,
  } as const;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-[minmax(0,1fr)_9rem] items-center gap-3">
        <button
          type="button"
          className="hover:bg-muted/40 -mx-2 flex min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors"
          disabled={!directory}
          onClick={async () => {
            if (directory) await openerCommands.openPath(directory, null);
          }}
        >
          <FolderSimple className="text-muted-foreground size-4 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium">
              <Trans>Archive recordings</Trans>
            </p>
            <p
              className="text-muted-foreground truncate text-xs"
              title={directory || undefined}
            >
              {directory ? (
                displayPath(directory, home)
              ) : (
                <Trans>Off: recordings stay on this device</Trans>
              )}
            </p>
          </div>
        </button>
        <Button
          type="button"
          variant="outline"
          className="h-9 w-full justify-center"
          disabled={disabled}
          onClick={() => changeMutation.mutate("choose")}
        >
          {changeMutation.isPending && (
            <CircleNotch className="size-4 animate-spin" aria-hidden="true" />
          )}
          <Trans>Choose folder</Trans>
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        <Trans>
          Move recordings to this folder, for example in iCloud Drive, to free
          up space. In iCloud, this Mac keeps only a placeholder: the recording
          stays in the note and downloads when you press play. Audio file
          retention still applies.
        </Trans>
      </p>
      {directory && (
        <>
          <SettingRow
            title={<Trans>Archive delay</Trans>}
            description={
              <Trans>How old a recording must be before it moves.</Trans>
            }
          >
            {(labelProps) => (
              <Select
                value={after}
                onValueChange={(value) => afterMutation.mutate(value)}
              >
                <SelectTrigger
                  {...labelProps}
                  className={SETTING_CONTROL_CLASS}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ARCHIVE_AFTER_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {copyByValue[option]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </SettingRow>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="self-start px-0"
            disabled={disabled}
            onClick={() => changeMutation.mutate("stop")}
          >
            <Trans>Stop archiving</Trans>
          </Button>
        </>
      )}
      {(settings.error || changeMutation.error || afterMutation.error) && (
        <p role="alert" className="text-xs text-red-500">
          <Trans>Could not update the archive settings</Trans>
        </p>
      )}
    </div>
  );
}
