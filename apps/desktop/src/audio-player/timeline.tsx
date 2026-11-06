import { Trans, useLingui } from "@lingui/react/macro";
import { useCallback, useMemo, useState } from "react";

import { CircleNotch, Cloud, Pause, Play } from "@anlg/ui/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@anlg/ui/components/ui/dropdown-menu";
import { cn } from "@anlg/utils";

import { useAudioPlayer, useAudioTime } from "./provider";
import { TimelineMeta, TimelineShell } from "./timeline-shell";

import { useNativeContextMenu } from "~/shared/hooks/useNativeContextMenu";

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

export function Timeline({
  contentClassName,
}: {
  contentClassName?: string;
} = {}) {
  const {
    registerContainer,
    state,
    pause,
    resume,
    start,
    stop,
    playbackRate,
    setPlaybackRate,
    deleteRecording,
    isDeletingRecording,
    audioOffloaded,
    isDownloadingAudio,
    audioDownloadFailed,
  } = useAudioPlayer();
  const { t } = useLingui();
  const time = useAudioTime();
  const [showRateMenu, setShowRateMenu] = useState(false);

  const handleClick = () => {
    if (state === "playing") {
      pause();
    } else if (state === "paused") {
      resume();
    } else if (state === "stopped") {
      start();
    }
  };

  const handleDeleteRecording = useCallback(async () => {
    setShowRateMenu(false);
    await deleteRecording();
  }, [deleteRecording]);

  const contextMenu = useMemo(
    () => [
      ...(state === "paused"
        ? [{ id: "resume", text: "Resume", action: resume }]
        : []),
      ...(state === "stopped"
        ? [{ id: "play", text: "Play", action: start }]
        : []),
      ...(state === "playing"
        ? [{ id: "pause", text: "Pause", action: pause }]
        : []),
      ...(state !== "stopped"
        ? [{ id: "stop", text: "Stop", action: stop }]
        : []),
      { separator: true as const },
      {
        id: "delete-recording",
        text: "Delete recording",
        action: () => void handleDeleteRecording(),
        disabled: isDeletingRecording,
      },
    ],
    [
      state,
      resume,
      start,
      pause,
      stop,
      isDeletingRecording,
      handleDeleteRecording,
    ],
  );
  const showContextMenu = useNativeContextMenu(contextMenu);

  return (
    <TimelineShell
      contentClassName={contentClassName}
      onContextMenu={showContextMenu}
      leading={
        <button
          onClick={handleClick}
          disabled={isDownloadingAudio}
          aria-label={
            audioOffloaded ? t`Download from iCloud and play` : undefined
          }
          className={cn([
            "flex items-center justify-center",
            "h-7 w-7 rounded-full",
            "border-border bg-card border",
            "hover:bg-accent transition-all hover:scale-110",
            "shrink-0 shadow-xs select-none",
          ])}
        >
          {isDownloadingAudio ? (
            <CircleNotch
              className="text-foreground h-3.5 w-3.5 animate-spin"
              aria-hidden="true"
            />
          ) : audioOffloaded ? (
            <Cloud className="text-foreground h-3.5 w-3.5" aria-hidden="true" />
          ) : state === "playing" ? (
            <Pause className="text-foreground h-3.5 w-3.5" />
          ) : (
            <Play className="text-foreground h-3.5 w-3.5" />
          )}
        </button>
      }
      meta={
        <>
          <TimelineMeta>
            <span>{formatTime(time.current)}</span>/
            <span>{formatTime(time.total)}</span>
          </TimelineMeta>

          <DropdownMenu
            modal={false}
            open={showRateMenu}
            onOpenChange={setShowRateMenu}
          >
            <DropdownMenuTrigger asChild>
              <button
                className={cn([
                  "flex shrink-0 items-center justify-center",
                  "h-6 rounded-md px-1.5",
                  "border-border bg-card border",
                  "hover:bg-accent transition-colors",
                  "text-muted-foreground font-mono text-xs select-none",
                  "shadow-xs",
                ])}
              >
                {playbackRate}x
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="top"
              align="end"
              className="border-border bg-card min-w-0 rounded-lg p-0 py-1"
            >
              {PLAYBACK_RATES.map((rate) => (
                <DropdownMenuItem
                  key={rate}
                  onSelect={() => setPlaybackRate(rate)}
                  className={cn([
                    "block w-full rounded-none px-3 py-1 text-left font-mono text-xs select-none",
                    "hover:bg-accent focus:bg-accent transition-colors",
                    rate === playbackRate
                      ? "text-foreground font-semibold"
                      : "text-muted-foreground",
                  ])}
                >
                  {rate}x
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
      main={
        audioOffloaded ? (
          <p
            className={cn([
              "flex h-6 min-w-0 flex-1 items-center truncate text-xs",
              audioDownloadFailed ? "text-red-500" : "text-muted-foreground",
            ])}
            role={audioDownloadFailed ? "alert" : undefined}
          >
            {isDownloadingAudio ? (
              <Trans>Downloading the recording from iCloud…</Trans>
            ) : audioDownloadFailed ? (
              <Trans>
                Could not download the recording. Check your connection and try
                again.
              </Trans>
            ) : (
              <Trans>In iCloud: press play to download it.</Trans>
            )}
          </p>
        ) : (
          <div
            ref={registerContainer}
            className="h-6 min-w-0 flex-1"
            style={{ width: "100%" }}
          />
        )
      }
    />
  );
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}
