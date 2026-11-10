import {
  AudioWave01Icon,
  PauseIcon,
  PlayIcon,
} from "@hugeicons/core-free-icons";
import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/ui/icon";

const RANGE_STYLE =
  "h-1 cursor-pointer appearance-none rounded-full bg-foreground/15 [&::-webkit-slider-thumb]:size-[11px] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-moz-range-thumb]:size-[11px] [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-primary";
const WAVEFORM_BARS = 64;
const MAX_WAVEFORM_BYTES = 8 * 1024 * 1024;
const MAX_WAVEFORM_SECONDS = 10 * 60;

interface AudioPreviewPlayerProps {
  filename: string;
  mediaType: string;
  objectUrl: string;
  onError: () => void;
  sourceSizeBytes?: number;
}

function formatTime(seconds: number) {
  const total = Number.isFinite(seconds) ? Math.floor(seconds) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = String(total % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}`
    : `${minutes}:${remainder}`;
}

export function AudioPreviewPlayer({
  filename,
  mediaType,
  objectUrl,
  onError,
  sourceSizeBytes,
}: AudioPreviewPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [waveform, setWaveform] = useState<number[]>();
  const [playError, setPlayError] = useState(false);

  useEffect(() => {
    if (
      !duration ||
      duration > MAX_WAVEFORM_SECONDS ||
      !sourceSizeBytes ||
      sourceSizeBytes > MAX_WAVEFORM_BYTES ||
      typeof AudioContext === "undefined"
    )
      return;
    const controller = new AbortController();
    let context: AudioContext | undefined;
    void (async () => {
      try {
        const response = await fetch(objectUrl, {
          credentials: "include",
          signal: controller.signal,
        });
        if (!response.ok) return;
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > MAX_WAVEFORM_BYTES || controller.signal.aborted)
          return;
        context = new AudioContext();
        const decoded = await context.decodeAudioData(bytes);
        if (
          decoded.duration > MAX_WAVEFORM_SECONDS ||
          controller.signal.aborted
        )
          return;
        const channels = Array.from(
          { length: decoded.numberOfChannels },
          (_, index) => decoded.getChannelData(index),
        );
        const samples = channels[0];
        if (!samples) return;
        const peaks = Array.from({ length: WAVEFORM_BARS }, (_, index) => {
          const start = Math.floor((index * samples.length) / WAVEFORM_BARS);
          const end = Math.floor(
            ((index + 1) * samples.length) / WAVEFORM_BARS,
          );
          let peak = 0;
          for (const channel of channels) {
            for (let sample = start; sample < end; sample += 1)
              peak = Math.max(peak, Math.abs(channel[sample] ?? 0));
          }
          return peak;
        });
        const max = Math.max(...peaks, 0.001);
        setWaveform(peaks.map((peak) => Math.max(0.08, peak / max)));
      } catch {
        // Playback remains available when waveform decoding is unsupported.
      } finally {
        if (context) void context.close();
      }
    })();
    return () => controller.abort();
  }, [duration, objectUrl, sourceSizeBytes]);

  const seek = (value: number) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    audio.currentTime = Math.min(duration, Math.max(0, value));
    setTime(audio.currentTime);
  };

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    setPlayError(false);
    try {
      await audio.play();
    } catch {
      setPlayError(true);
    }
  };

  return (
    <div className="flex w-full max-w-[560px] flex-col items-center text-app-ink">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- User-provided audio has no caption track to reference. */}
      <audio
        ref={audioRef}
        onDurationChange={(event) =>
          setDuration(
            Number.isFinite(event.currentTarget.duration)
              ? event.currentTarget.duration
              : 0,
          )
        }
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={onError}
        preload="metadata"
        title={filename}
      >
        <source src={objectUrl} type={mediaType} />
      </audio>
      <span className="mb-[18px] flex size-[54px] items-center justify-center rounded-[18px] bg-sidebar-muted text-muted-foreground">
        <Icon icon={AudioWave01Icon} size={24} />
      </span>
      <h3 className="max-w-full break-all text-center text-base font-medium">
        {filename}
      </h3>
      <p className="mt-1 text-xs text-app-muted">
        Audio{duration > 0 ? ` · ${formatTime(duration)}` : ""}
      </p>
      {waveform ? (
        <div
          aria-label="Audio waveform"
          className="mt-9 flex h-[72px] w-full items-center justify-center gap-[3px] overflow-hidden"
          role="img"
        >
          {waveform.map((peak, index) => (
            <span
              className="min-w-0 flex-1 rounded-full"
              key={index}
              style={{
                height: `${peak * 100}%`,
                backgroundColor:
                  index / WAVEFORM_BARS < time / duration
                    ? "hsl(var(--town-foreground) / 0.65)"
                    : "hsl(var(--town-muted-foreground) / 0.3)",
              }}
            />
          ))}
        </div>
      ) : (
        <div
          aria-hidden="true"
          className="mt-9 flex h-[72px] w-full items-center"
        >
          <span className="h-px w-full bg-foreground/10" />
        </div>
      )}
      <input
        aria-label="Audio position"
        className={`${RANGE_STYLE} mt-4 w-full disabled:opacity-50`}
        disabled={!duration}
        max={duration || 0}
        min={0}
        onChange={(event) => seek(Number(event.target.value))}
        step="0.1"
        type="range"
        value={Math.min(time, duration || 0)}
      />
      <div className="mt-2 flex w-full justify-between text-xs tabular-nums text-app-muted">
        <span>{formatTime(time)}</span>
        <span>{formatTime(duration)}</span>
      </div>
      <div className="mt-5 flex items-center">
        <button
          aria-label={playing ? "Pause" : "Play"}
          className="flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-app-focus"
          onClick={() => void togglePlayback()}
          type="button"
        >
          <Icon icon={playing ? PauseIcon : PlayIcon} size={20} />
        </button>
      </div>
      {playError ? (
        <p className="mt-3 text-center text-sm text-app-muted" role="alert">
          Playback could not start. Please try again.
        </p>
      ) : null}
    </div>
  );
}
