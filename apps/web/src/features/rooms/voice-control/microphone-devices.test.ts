import { describe, expect, it, vi } from "vitest";

import {
  describeVoiceMediaError,
  discoverVoiceMicrophones,
  listVoiceMicrophones,
  matchBoundVoiceMicrophone,
  requestVoiceMicrophones,
  retryOnVoiceMediaAbort,
} from "./microphone-devices";

describe("requestVoiceMicrophones", () => {
  it("does not reopen a microphone after cancellation during retry backoff", async () => {
    vi.useFakeTimers();
    try {
      const caller = new AbortController();
      const operation = vi
        .fn()
        .mockRejectedValueOnce(new DOMException("Interrupted", "AbortError"))
        .mockResolvedValue("opened");
      const pending = retryOnVoiceMediaAbort(operation, caller.signal).then(
        () => "resolved",
        () => "cancelled",
      );
      await vi.advanceTimersByTimeAsync(0);
      caller.abort();
      await vi.advanceTimersByTimeAsync(120);
      expect(operation).toHaveBeenCalledOnce();
      expect(await pending).toBe("cancelled");
    } finally {
      vi.useRealTimers();
    }
  });
  it("times out a pending device connection and closes a late stream", async () => {
    vi.useFakeTimers();
    const stop = vi.fn();
    let resolveStream!: (stream: MediaStream) => void;
    const opening = requestVoiceMicrophones({
      mediaDevices: {
        enumerateDevices: vi.fn(async () => []),
        getUserMedia: vi.fn(
          () =>
            new Promise<MediaStream>((resolve) => {
              resolveStream = resolve;
            }),
        ),
      },
      timeoutMs: 1_000,
    });
    const assertion = expect(opening).rejects.toThrow(
      "Microphone connection timed out",
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    resolveStream({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await vi.runAllTimersAsync();

    expect(stop).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("uses a remembered device when it is still connected and releases permission tracks", async () => {
    const stop = vi.fn();
    const mediaDevices = {
      enumerateDevices: vi.fn(async () => [
        device("built-in", "MacBook Microphone"),
        device("wireless", "Wireless microphone"),
      ]),
      getUserMedia: vi.fn(
        async () =>
          ({
            getAudioTracks: () => [
              { getSettings: () => ({ deviceId: "built-in" }) },
            ],
            getTracks: () => [{ stop }],
          }) as unknown as MediaStream,
      ),
    };

    await expect(
      requestVoiceMicrophones({
        mediaDevices,
        preferredDeviceId: "wireless",
      }),
    ).resolves.toEqual({
      devices: [
        {
          deviceId: "built-in",
          groupId: "built-in-group",
          label: "MacBook Microphone",
        },
        {
          deviceId: "wireless",
          groupId: "wireless-group",
          label: "Wireless microphone",
        },
      ],
      selectedDeviceId: "wireless",
    });
    expect(stop).toHaveBeenCalledOnce();
  });

  it("lists labeled microphones without opening a new capture", async () => {
    const mediaDevices = {
      enumerateDevices: vi.fn(async () => [
        device("built-in", "MacBook Air Microphone (Built-in)"),
        device("wireless", "Wireless microphone"),
      ]),
      getUserMedia: vi.fn(),
    };

    await expect(
      discoverVoiceMicrophones({
        mediaDevices,
        preferredDeviceId: "wireless",
      }),
    ).resolves.toEqual({
      devices: [
        {
          deviceId: "built-in",
          groupId: "built-in-group",
          label: "MacBook Air Microphone (Built-in)",
        },
        {
          deviceId: "wireless",
          groupId: "wireless-group",
          label: "Wireless microphone",
        },
      ],
      selectedDeviceId: "wireless",
    });
    expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it("requests permission when device labels are still hidden", async () => {
    const stop = vi.fn();
    const mediaDevices = {
      enumerateDevices: vi.fn(async () => [
        device("built-in", ""),
        device("wireless", ""),
      ]),
      getUserMedia: vi.fn(
        async () =>
          ({
            getAudioTracks: () => [
              { getSettings: () => ({ deviceId: "built-in" }) },
            ],
            getTracks: () => [{ stop }],
          }) as unknown as MediaStream,
      ),
    };

    await expect(
      discoverVoiceMicrophones({ mediaDevices }),
    ).resolves.toMatchObject({
      selectedDeviceId: "built-in",
    });
    expect(mediaDevices.getUserMedia).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("asks the browser which microphone it grants when none is remembered", async () => {
    const stop = vi.fn();
    const mediaDevices = {
      enumerateDevices: vi.fn(async () => [
        device("built-in", "MacBook Microphone"),
        device("external", "External microphone"),
      ]),
      getUserMedia: vi.fn(
        async () =>
          ({
            getAudioTracks: () => [
              { getSettings: () => ({ deviceId: "external" }) },
            ],
            getTracks: () => [{ stop }],
          }) as unknown as MediaStream,
      ),
    };

    await expect(
      discoverVoiceMicrophones({ mediaDevices }),
    ).resolves.toMatchObject({ selectedDeviceId: "external" });
    expect(mediaDevices.getUserMedia).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("retries a transient getUserMedia abort and then opens the microphone", async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(
        new DOMException("signal is aborted without reason", "AbortError"),
      )
      .mockResolvedValueOnce({
        getAudioTracks: () => [],
        getTracks: () => [{ stop: vi.fn() }],
      });

    await expect(
      requestVoiceMicrophones({
        mediaDevices: {
          enumerateDevices: vi.fn(async () => [
            device("built-in", "MacBook Microphone"),
          ]),
          getUserMedia,
        },
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ selectedDeviceId: "built-in" });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("does not show the browser abort string for microphone interruptions", () => {
    expect(
      describeVoiceMediaError(
        new DOMException("signal is aborted without reason", "AbortError"),
      ),
    ).toBe("Microphone connection was interrupted");
  });

  it("recovers a binding when the browser rotates its device ID", () => {
    const devices = [device("rotated", "Wireless microphone", "wireless")].map(
      (item) => ({
        deviceId: item.deviceId,
        groupId: item.groupId,
        label: item.label,
      }),
    );
    expect(
      matchBoundVoiceMicrophone(devices, {
        deviceId: "old-id",
        groupId: "wireless",
        label: "Wireless microphone",
      }),
    ).toEqual(devices[0]);
  });

  it("migrates a previously saved default alias to its physical input", () => {
    const physical = {
      deviceId: "built-in",
      groupId: "built-in-group",
      label: "MacBook Air Microphone (Built-in)",
    };

    expect(
      matchBoundVoiceMicrophone([physical], {
        deviceId: "default",
        groupId: "built-in-group",
        label: "Default - MacBook Air Microphone (Built-in)",
      }),
    ).toEqual(physical);
  });

  it("omits the mutable system default alias and deduplicates physical devices", async () => {
    const mediaDevices = {
      enumerateDevices: vi.fn(async () => [
        device(
          "default",
          "Default - MacBook Air Microphone (Built-in)",
          "built-in-group",
        ),
        device(
          "built-in",
          "MacBook Air Microphone (Built-in)",
          "built-in-group",
        ),
        device("wireless", "Wireless microphone", "wireless-group"),
        device("wireless-copy", "Wireless microphone", "wireless-group"),
      ]),
    };

    await expect(listVoiceMicrophones(mediaDevices)).resolves.toEqual([
      {
        deviceId: "built-in",
        groupId: "built-in-group",
        label: "MacBook Air Microphone (Built-in)",
      },
      {
        deviceId: "wireless",
        groupId: "wireless-group",
        label: "Wireless microphone",
      },
    ]);
  });
});

function device(
  deviceId: string,
  label: string,
  groupId = `${deviceId}-group`,
) {
  return {
    deviceId,
    groupId,
    kind: "audioinput",
    label,
  } as MediaDeviceInfo;
}
