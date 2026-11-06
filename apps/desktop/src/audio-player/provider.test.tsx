import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  audioExist: vi.fn(),
  audioAvailability: vi.fn(),
  audioDownload: vi.fn(),
  loadWaveform: vi.fn(),
  play: vi.fn(),
}));

vi.mock("@anlg/plugin-fs-sync", () => ({
  commands: {
    audioExist: mocks.audioExist,
    audioAvailability: mocks.audioAvailability,
    audioDownload: mocks.audioDownload,
  },
}));

vi.mock("wavesurfer.js", () => ({
  default: {
    create: () => ({
      on: vi.fn(),
      play: mocks.play,
      pause: vi.fn(),
      stop: vi.fn(),
      setTime: vi.fn(),
      setPlaybackRate: vi.fn(),
      isPlaying: () => false,
      getCurrentTime: () => 0,
      getDuration: () => 0,
      destroy: vi.fn(),
    }),
  },
}));

vi.mock("./waveform", () => ({ loadWaveform: mocks.loadWaveform }));
vi.mock("./playback", () => ({
  configureCenteredPlayback: () => null,
  shouldResumeBeforePlay: () => false,
}));
vi.mock("~/services/audio-retention", () => ({
  isSessionAudioIdle: () => true,
  subscribeToSessionAudioRetention: () => () => {},
}));
vi.mock("~/session/attachments", () => ({ deleteSessionAudio: vi.fn() }));

import { AudioPlayerProvider, useAudioPlayer } from "./provider";

let player: ReturnType<typeof useAudioPlayer>;

function Probe() {
  player = useAudioPlayer();
  return <div ref={player.registerContainer} />;
}

function renderPlayer() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AudioPlayerProvider sessionId="session-1" url="asset://audio.mp3">
        <Probe />
      </AudioPlayerProvider>
    </QueryClientProvider>,
  );
}

describe("AudioPlayerProvider with an archived recording", () => {
  beforeEach(() => {
    mocks.audioExist.mockResolvedValue({ status: "ok", data: true });
    mocks.loadWaveform.mockResolvedValue(undefined);
    mocks.play.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("downloads an offloaded recording only when play is pressed, then plays it", async () => {
    mocks.audioAvailability.mockResolvedValue({
      status: "ok",
      data: { archived: true, local: false },
    });
    mocks.audioDownload.mockResolvedValue({ status: "ok", data: null });
    renderPlayer();

    await waitFor(() => expect(player.audioOffloaded).toBe(true));
    expect(mocks.loadWaveform).not.toHaveBeenCalled();

    act(() => player.start());

    await waitFor(() => expect(mocks.loadWaveform).toHaveBeenCalledTimes(1));
    expect(mocks.audioDownload).toHaveBeenCalledWith("session-1");
    await waitFor(() => expect(mocks.play).toHaveBeenCalled());
    expect(player.audioOffloaded).toBe(false);
  });

  it("loads a recording that is still on this disk as soon as the note opens", async () => {
    mocks.audioAvailability.mockResolvedValue({
      status: "ok",
      data: { archived: true, local: true },
    });
    renderPlayer();

    await waitFor(() => expect(mocks.loadWaveform).toHaveBeenCalledTimes(1));
    expect(mocks.audioDownload).not.toHaveBeenCalled();
    expect(mocks.play).not.toHaveBeenCalled();
  });
});
