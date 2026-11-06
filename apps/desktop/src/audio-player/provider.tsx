import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import WaveSurfer from "wavesurfer.js";

import { commands as fsSyncCommands } from "@anlg/plugin-fs-sync";
import type { SessionAudioRetentionEvent } from "@anlg/plugin-transcription";
import { useMountEffect } from "@anlg/ui/hooks/use-mount-effect";

import { configureCenteredPlayback, shouldResumeBeforePlay } from "./playback";
import { loadWaveform } from "./waveform";

import {
  isSessionAudioIdle,
  subscribeToSessionAudioRetention,
} from "~/services/audio-retention";
import { deleteSessionAudio } from "~/session/attachments";

const TIME_UPDATE_STEP_SECONDS = 0.1;

type AudioPlayerState = "playing" | "paused" | "stopped";

interface TimeSnapshot {
  current: number;
  total: number;
}

class TimeStore {
  private snapshot: TimeSnapshot = { current: 0, total: 0 };
  private listeners = new Set<() => void>();

  getSnapshot = (): TimeSnapshot => {
    return this.snapshot;
  };

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  setCurrent(value: number) {
    if (value === this.snapshot.current) return;
    this.snapshot = { ...this.snapshot, current: value };
    this.notify();
  }

  setTotal(value: number) {
    if (value === this.snapshot.total) return;
    this.snapshot = { ...this.snapshot, total: value };
    this.notify();
  }

  reset() {
    this.snapshot = { current: 0, total: 0 };
    this.notify();
  }

  private notify() {
    for (const cb of this.listeners) {
      cb();
    }
  }
}

interface AudioPlayerContextValue {
  registerContainer: (el: HTMLDivElement | null) => void;
  wavesurfer: WaveSurfer | null;
  state: AudioPlayerState;
  timeStore: TimeStore;
  start: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  seek: (sec: number) => void;
  audioExists: boolean;
  audioExistsResolved: boolean;
  playbackRate: number;
  setPlaybackRate: (rate: number) => void;
  deleteRecording: () => Promise<void>;
  isDeletingRecording: boolean;
  /** [fork] The recording is archived and only in the cloud for now. */
  audioOffloaded: boolean;
  isDownloadingAudio: boolean;
  audioDownloadFailed: boolean;
}

const AudioPlayerContext = createContext<AudioPlayerContextValue | null>(null);

export function useAudioPlayer() {
  const context = useContext(AudioPlayerContext);
  if (!context) {
    throw new Error("useAudioPlayer must be used within AudioPlayerProvider");
  }
  return context;
}

export function useAudioTime(): TimeSnapshot {
  const { timeStore } = useAudioPlayer();
  return useSyncExternalStore(timeStore.subscribe, timeStore.getSnapshot);
}

function useAudioExistence(sessionId: string) {
  const audioExists = useQuery({
    queryKey: ["audio", sessionId, "exist"],
    queryFn: () => fsSyncCommands.audioExist(sessionId),
    select: (result) => {
      if (result.status === "error") {
        throw new Error(result.error);
      }
      return result.data;
    },
  });

  return {
    audioExists: audioExists.data ?? false,
    audioExistsResolved: audioExists.isSuccess,
  };
}

// [fork] Read once per note opening: re-reading while the note stays open
// could flag a recording that the player already holds as offloaded, and
// tear the loaded player down.
function useAudioAvailability(sessionId: string) {
  return useQuery({
    queryKey: ["audio", sessionId, "availability"],
    queryFn: async () => {
      const result = await fsSyncCommands.audioAvailability(sessionId);
      if (result.status === "error") {
        throw new Error(result.error);
      }
      return result.data;
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

export function useAudioExists(sessionId: string): boolean {
  return useAudioExistence(sessionId).audioExists;
}

export function AudioPlayerProvider({
  sessionId,
  url,
  children,
}: {
  sessionId: string;
  url: string;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [wavesurfer, setWavesurfer] = useState<WaveSurfer | null>(null);
  const [state, setState] = useState<AudioPlayerState>("stopped");
  const [playbackRate, setPlaybackRateState] = useState(1);
  const timeStoreRef = useRef(new TimeStore());
  const stopRequestedRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const { audioExists: audioExistsValue, audioExistsResolved } =
    useAudioExistence(sessionId);
  const availability = useAudioAvailability(sessionId);
  const audioOffloaded = Boolean(
    availability.data?.archived && !availability.data.local,
  );
  // Until it is known, loading could pull an offloaded recording on opening.
  const availabilityKnown = !availability.isPending;
  // What the user asked for while the recording was still downloading.
  const pendingAfterDownloadRef = useRef<
    { type: "play" } | { type: "seek"; time: number } | null
  >(null);
  const downloadMutation = useMutation({
    mutationFn: async () => {
      const result = await fsSyncCommands.audioDownload(sessionId);
      if (result.status === "error") {
        throw new Error(result.error);
      }
    },
    onSuccess: () => {
      queryClient.setQueryData(["audio", sessionId, "availability"], {
        archived: true,
        local: true,
      });
    },
    onError: () => {
      pendingAfterDownloadRef.current = null;
    },
  });
  const requestDownload = downloadMutation.mutate;

  const registerContainer = useCallback((el: HTMLDivElement | null) => {
    setContainer((prev) => (prev === el ? prev : el));
  }, []);

  useEffect(() => {
    // An offloaded recording is fetched on demand, not on opening the note.
    if (!container || !url || !availabilityKnown || audioOffloaded) {
      return;
    }

    const store = timeStoreRef.current;
    store.reset();
    stopRequestedRef.current = false;

    let lastReportedTime = 0;

    const media = new Audio();
    media.crossOrigin = "anonymous";
    media.preload = "metadata";

    const ws = WaveSurfer.create({
      container,
      media,
      height: 24,
      waveColor: "#e5e5e5",
      progressColor: "#a8a8a8",
      cursorColor: "#737373",
      cursorWidth: 2,
      barWidth: 3,
      barGap: 2,
      barRadius: 2,
      barHeight: 1,
      dragToSeek: true,
      normalize: true,
      splitChannels: [
        { waveColor: "#e8d5d5", progressColor: "#c9a3a3", overlay: true },
        { waveColor: "#d5dde8", progressColor: "#a3b3c9", overlay: true },
      ],
    });
    const audioContext = configureCenteredPlayback(media);
    audioContextRef.current = audioContext;

    const syncCurrentTime = (currentTime: number, force = false) => {
      if (
        !force &&
        Math.abs(currentTime - lastReportedTime) < TIME_UPDATE_STEP_SECONDS
      ) {
        return;
      }

      lastReportedTime = currentTime;
      store.setCurrent(currentTime);
    };

    const handleReady = (dur: number) => {
      if (dur && isFinite(dur)) {
        store.setTotal(dur);
      }
    };

    const handlePlay = () => {
      stopRequestedRef.current = false;
      syncCurrentTime(ws.getCurrentTime(), true);
      setState("playing");
    };

    const handlePause = () => {
      const currentTime = ws.getCurrentTime();
      syncCurrentTime(currentTime, true);

      if (stopRequestedRef.current) {
        stopRequestedRef.current = false;
        setState("stopped");
        return;
      }

      setState("paused");
    };

    const handleFinish = () => {
      stopRequestedRef.current = false;
      syncCurrentTime(ws.getDuration(), true);
      setState("stopped");
    };

    const handleTimeupdate = (currentTime: number) => {
      syncCurrentTime(currentTime);
    };

    const handleInteraction = (currentTime: number) => {
      syncCurrentTime(currentTime, true);
    };

    const handleDecode = (dur: number) => {
      if (dur && isFinite(dur)) {
        store.setTotal(dur);
      }
    };

    const handleDestroy = () => {
      stopRequestedRef.current = false;
      setState("stopped");
    };

    ws.on("decode", handleDecode);
    ws.on("play", handlePlay);
    ws.on("pause", handlePause);
    ws.on("finish", handleFinish);
    ws.on("ready", handleReady);
    ws.on("timeupdate", handleTimeupdate);
    ws.on("interaction", handleInteraction);
    ws.on("destroy", handleDestroy);

    setWavesurfer(ws);

    const loadController = new AbortController();
    void loadWaveform(ws, {
      url,
      sessionId,
      signal: loadController.signal,
    })
      .then(() => {
        const pending = pendingAfterDownloadRef.current;
        pendingAfterDownloadRef.current = null;
        if (loadController.signal.aborted || !pending) return;
        if (pending.type === "seek") ws.setTime(pending.time);
        void ws.play();
      })
      .catch(() => {});

    return () => {
      loadController.abort();
      stopRequestedRef.current = false;
      if (audioContextRef.current === audioContext) {
        audioContextRef.current = null;
      }
      const mediaSrc = media.currentSrc || media.src;
      media.pause();
      ws.destroy();
      if (mediaSrc.startsWith("blob:")) {
        URL.revokeObjectURL(mediaSrc);
      }
      media.removeAttribute("src");
      media.load();
      setWavesurfer(null);
      void audioContext?.close();
    };
  }, [container, sessionId, url, availabilityKnown, audioOffloaded]);

  const play = useCallback(() => {
    if (audioOffloaded) {
      pendingAfterDownloadRef.current = { type: "play" };
      requestDownload();
      return;
    }
    if (!wavesurfer) {
      return;
    }

    const audioContext = audioContextRef.current;
    if (shouldResumeBeforePlay(audioContext)) {
      void audioContext
        .resume()
        .then(() => {
          if (audioContextRef.current === audioContext) {
            return wavesurfer.play();
          }
        })
        .catch(() => {});
      return;
    }

    void wavesurfer.play();
  }, [wavesurfer, audioOffloaded, requestDownload]);

  const pause = useCallback(() => {
    if (wavesurfer) {
      wavesurfer.pause();
    }
  }, [wavesurfer]);

  const stop = useCallback(() => {
    if (wavesurfer) {
      const wasPlaying = wavesurfer.isPlaying();
      stopRequestedRef.current = wasPlaying;
      wavesurfer.stop();
      timeStoreRef.current.setCurrent(0);
      if (!wasPlaying) {
        setState("stopped");
      }
    }
  }, [wavesurfer]);

  const markAudioDeleted = useCallback(() => {
    timeStoreRef.current.reset();
    queryClient.setQueryData(["audio", sessionId, "exist"], {
      status: "ok",
      data: false,
    });
    queryClient.setQueryData(["audio", sessionId, "url"], {
      status: "error",
      error: "audio_path_not_found",
    });
    void queryClient.invalidateQueries({
      queryKey: ["audio", sessionId, "exist"],
    });
    void queryClient.invalidateQueries({
      queryKey: ["audio", sessionId, "url"],
    });
  }, [queryClient, sessionId]);
  const retentionHandlerRef = useRef(
    (_event: SessionAudioRetentionEvent) => {},
  );
  retentionHandlerRef.current = (event) => {
    if (event.session_id !== sessionId) {
      return;
    }
    stop();
    if (event.phase === "deleted") {
      markAudioDeleted();
    }
  };
  useMountEffect(() =>
    subscribeToSessionAudioRetention((event) =>
      retentionHandlerRef.current(event),
    ),
  );

  const seek = useCallback(
    (timeInSeconds: number) => {
      if (audioOffloaded) {
        pendingAfterDownloadRef.current = { type: "seek", time: timeInSeconds };
        requestDownload();
        return;
      }
      if (wavesurfer) {
        wavesurfer.setTime(timeInSeconds);
      }
    },
    [wavesurfer, audioOffloaded, requestDownload],
  );

  const setPlaybackRate = useCallback(
    (rate: number) => {
      if (wavesurfer) {
        wavesurfer.setPlaybackRate(rate, false);
      }
      setPlaybackRateState(rate);
    },
    [wavesurfer],
  );

  useEffect(() => {
    if (!wavesurfer) {
      return;
    }

    wavesurfer.setPlaybackRate(playbackRate, false);
  }, [playbackRate, wavesurfer]);

  const deleteRecordingMutation = useMutation({
    mutationFn: async () => {
      stop();
      const deleted = await deleteSessionAudio(sessionId, () =>
        isSessionAudioIdle(sessionId),
      );
      if (!deleted) {
        throw new Error("audio_session_busy");
      }
    },
    onSuccess: markAudioDeleted,
  });

  const value = useMemo<AudioPlayerContextValue>(
    () => ({
      registerContainer,
      wavesurfer,
      state,
      timeStore: timeStoreRef.current,
      start: play,
      pause,
      resume: play,
      stop,
      seek,
      audioExists: audioExistsValue,
      audioExistsResolved,
      playbackRate,
      setPlaybackRate,
      deleteRecording: deleteRecordingMutation.mutateAsync,
      isDeletingRecording: deleteRecordingMutation.isPending,
      audioOffloaded,
      isDownloadingAudio: downloadMutation.isPending,
      audioDownloadFailed: downloadMutation.isError,
    }),
    [
      registerContainer,
      wavesurfer,
      state,
      play,
      pause,
      stop,
      seek,
      audioExistsValue,
      audioExistsResolved,
      playbackRate,
      setPlaybackRate,
      deleteRecordingMutation.mutateAsync,
      deleteRecordingMutation.isPending,
      audioOffloaded,
      downloadMutation.isPending,
      downloadMutation.isError,
    ],
  );

  return (
    <AudioPlayerContext.Provider value={value}>
      {children}
    </AudioPlayerContext.Provider>
  );
}
