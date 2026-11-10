// The publisher must stay real time. A loaded developer machine may widen the
// limits for measurement only; acceptance runs keep the defaults.
const maxStallMs = Number(process.env.VOICE_SOAK_MAX_PUBLISH_STALL_MS ?? 250);
const maxDelayMs = Number(process.env.VOICE_SOAK_MAX_PUBLISH_DELAY_MS ?? 2_000);

/** Repeat 48 kHz mono input for an exact sample budget, including a short tail. */
export function* loopAudioFrames(pcm: Int16Array, durationMs: number) {
  const totalSamples = durationMs * 48;
  if (!pcm.length || !Number.isSafeInteger(totalSamples) || totalSamples <= 0)
    throw new Error("Invalid PCM or requested audio duration");
  for (let sent = 0; sent < totalSamples; sent += 480) {
    const samples = new Int16Array(Math.min(480, totalSamples - sent));
    for (let i = 0; i < samples.length; i++)
      samples[i] = pcm[(sent + i) % pcm.length]!;
    yield samples;
  }
}

/** Keep replaceable HTTP observations off the paced PCM producer. */
export async function playObservedAudio(options: {
  frames: Iterable<Int16Array>;
  captureFrame: (samples: Int16Array) => Promise<void>;
  observe: (signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
}) {
  const stopped = new AbortController();
  const signal = AbortSignal.any([options.signal, stopped.signal]);
  let observationFailure: { cause: unknown } | undefined;
  const observer = (async () => {
    while (!signal.aborted) {
      await options.observe(signal);
      await waitForNextObservation(signal);
    }
  })().catch((cause: unknown) => {
    if (!signal.aborted || cause !== signal.reason) {
      observationFailure = { cause };
      stopped.abort(cause);
    }
  });
  const check = () => {
    options.signal.throwIfAborted();
    if (observationFailure) throw observationFailure.cause;
  };
  const started = performance.now();
  let previousStart: number | undefined;
  let maxFrameGapMs = 0;
  let maxCaptureFrameMs = 0;
  let sentSamples = 0;
  let frames = 0;
  try {
    for (const samples of options.frames) {
      check();
      const frameStarted = performance.now();
      if (previousStart !== undefined) {
        const gap = frameStarted - previousStart;
        maxFrameGapMs = Math.max(maxFrameGapMs, gap);
        if (gap > maxStallMs)
          throw new Error(
            `Audio publisher frame gap exceeded ${maxStallMs}ms (${gap}ms)`,
          );
      }
      previousStart = frameStarted;
      await waitForCapturedFrame(() => options.captureFrame(samples), signal);
      const captureFrameMs = performance.now() - frameStarted;
      maxCaptureFrameMs = Math.max(maxCaptureFrameMs, captureFrameMs);
      if (captureFrameMs > maxStallMs)
        throw new Error(
          `Audio publisher captureFrame exceeded ${maxStallMs}ms (${captureFrameMs}ms)`,
        );
      sentSamples += samples.length;
      frames++;
      // Many small stalls can stretch a recording while every single gap stays
      // below the stall limit. Do not call that a real-time duration pass.
      if (performance.now() - started - sentSamples / 48 > maxDelayMs)
        throw new Error(
          `Audio publisher cumulative delay exceeded ${maxDelayMs}ms`,
        );
    }
    check();
  } finally {
    stopped.abort();
    await observer;
  }
  check();
  return {
    sent_audio_ms: sentSamples / 48,
    playback_elapsed_ms: performance.now() - started,
    frames_sent: frames,
    max_frame_gap_ms: maxFrameGapMs,
    max_capture_frame_ms: maxCaptureFrameMs,
  };
}

async function waitForCapturedFrame(
  capture: () => Promise<void>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  let rejectWait!: (cause: unknown) => void;
  const interrupted = new Promise<void>((_resolve, reject) => {
    rejectWait = reject;
  });
  const abort = () => rejectWait(signal.reason);
  const timer = setTimeout(
    () =>
      rejectWait(
        new Error(`Audio publisher captureFrame exceeded ${maxStallMs}ms`),
      ),
    maxStallMs,
  );
  signal.addEventListener("abort", abort, { once: true });
  try {
    // The SDK's native callback has no abort support. Stop waiting so the
    // runner's finally can disconnect and close the publisher/source.
    await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return capture();
      }),
      interrupted,
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

function waitForNextObservation(signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, 500);
    signal.addEventListener("abort", done, { once: true });
  });
}
