import { describe, expect, it, vi } from "vitest";
import {
  VoiceModeController,
  type VoiceModeEvent,
} from "./voice-mode-controller";
import { VoiceModeDisconnectedError } from "./voice-mode-errors";

function setup(
  send = vi.fn<(turn: { id: string; text: string }) => Promise<void>>(
    async () => undefined,
  ),
) {
  let receive!: (event: VoiceModeEvent) => void;
  let fail!: (error: unknown) => void;
  const close = vi.fn(async () => undefined);
  const commit = vi.fn(async () => undefined);
  const setMuted = vi.fn(async () => undefined);
  const connection = { commit, close, setMuted };
  const open = vi.fn(async (next: typeof receive, onFailure: typeof fail) => {
    receive = next;
    fail = onFailure;
    return connection;
  });
  const controller = new VoiceModeController({ open, send });
  return {
    controller,
    close,
    commit,
    setMuted,
    connection,
    open,
    send,
    receive: (event: VoiceModeEvent) => receive(event),
    fail: (error: unknown) => fail(error),
  };
}

const tick = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("Voice Mode turn delivery", () => {
  it("reconnects after a transient voice connection loss and preserves the draft", async () => {
    const f = setup();
    await f.controller.start();
    f.receive({
      kind: "partial",
      text: "draft before disconnect",
      endOffsetMs: 100,
    });
    f.fail(
      new VoiceModeDisconnectedError(
        "Voice connection was lost. Your unsent text is kept.",
      ),
    );
    expect(f.controller.getState()).toMatchObject({ status: "connecting" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(f.open).toHaveBeenCalledTimes(2);
    expect(f.controller.getState()).toMatchObject({
      status: "listening",
      text: "draft before disconnect",
    });
  });

  it("does not reconnect for a plain error carrying disconnect text", async () => {
    const f = setup();
    await f.controller.start();
    f.fail(new Error("Voice connection was lost. Your unsent text is kept."));
    expect(f.controller.getState().status).not.toBe("connecting");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(f.open).toHaveBeenCalledTimes(1);
  });

  it("applies a mute request made before the connection finishes opening", async () => {
    let release!: () => void;
    const f = setup();
    f.open.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(f.connection))),
    );
    const opening = f.controller.start();
    await f.controller.setMuted(true);
    release();
    await opening;
    expect(f.setMuted).toHaveBeenCalledWith(true);
  });

  it("freezes material context when a turn arrives, including a queued turn and its retry", async () => {
    let receive!: (event: VoiceModeEvent) => void;
    let release!: () => void;
    let selected = "first document";
    const committed: string[] = [];
    let failSecond = true;
    const send = vi.fn();
    const controller = new VoiceModeController({
      open: async (next) => {
        receive = next;
        return { close: async () => undefined, commit: async () => undefined };
      },
      send,
      prepareSend: (turn) => {
        const material = selected;
        return async () => {
          if (turn.id === "one")
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          if (turn.id === "two" && failSecond) {
            failSecond = false;
            throw new Error("offline");
          }
          committed.push(`${turn.id}:${material}`);
        };
      },
    });
    await controller.start();
    receive({
      kind: "turn",
      id: "one",
      text: "first request",
      endOffsetMs: 100,
    });
    selected = "second document";
    receive({
      kind: "turn",
      id: "two",
      text: "second request",
      endOffsetMs: 200,
    });
    selected = "third document";
    release();
    await controller.whenDeliverySettles();
    await controller.retry();
    expect(committed).toEqual(["one:first document", "two:second document"]);
    expect(send).not.toHaveBeenCalled();
  });
  it.each(["success", "failure"] as const)(
    "keeps an in-flight send out of the exit draft until its %s settles",
    async (outcome) => {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const send = vi.fn(
        () =>
          new Promise<void>((yes, no) => {
            resolve = yes;
            reject = no;
          }),
      );
      const f = setup(send);
      await f.controller.start();
      f.receive({
        kind: "turn",
        id: "in-flight",
        text: "already sent",
        endOffsetMs: 100,
      });
      f.receive({ kind: "partial", text: "next draft", endOffsetMs: 200 });
      await f.controller.pause();
      expect(f.controller.getState().text).toBe("next draft");
      if (outcome === "success") resolve();
      else reject(new Error("Send failed"));
      await f.controller.whenDeliverySettles();
      expect(f.controller.getState().text).toBe(
        outcome === "success" ? "next draft" : "already sent\nnext draft",
      );
      expect(send).toHaveBeenCalledOnce();
    },
  );
  it("never sends a partial or speech final; sends each Runtime turn once", async () => {
    const f = setup();
    await f.controller.start();
    f.receive({ kind: "partial", text: "start recording", endOffsetMs: 500 });
    f.receive({
      kind: "speech",
      id: "speech1",
      text: "start recording",
      endOffsetMs: 800,
    });
    await tick();
    expect(f.send).not.toHaveBeenCalled();
    const turn = {
      kind: "turn",
      id: "turn1",
      text: "start recording",
      endOffsetMs: 800,
    } as const;
    f.receive(turn);
    f.receive(turn);
    await tick();
    expect(f.send).toHaveBeenCalledExactlyOnceWith({
      id: "turn1",
      text: "start recording",
    });
    expect(f.controller.getState().text).toBe("");
    expect(f.close).not.toHaveBeenCalled();
  });

  it("sends identical text in distinct turns and buffers a next turn during delivery", async () => {
    let done!: () => void;
    const send = vi
      .fn<(turn: { id: string; text: string }) => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            done = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const f = setup(send);
    await f.controller.start();
    f.receive({ kind: "turn", id: "one", text: "hello", endOffsetMs: 100 });
    f.receive({ kind: "turn", id: "two", text: "hello", endOffsetMs: 200 });
    f.receive({ kind: "partial", text: "third line", endOffsetMs: 300 });
    expect(send).toHaveBeenCalledTimes(1);
    done();
    await tick();
    expect(send.mock.calls.map(([turn]) => turn.id)).toEqual(["one", "two"]);
    expect(f.controller.getState().text).toBe("third line");
    expect(f.open).toHaveBeenCalledTimes(1);
  });

  it("keeps newer partials through late speech/turn finals and ignores stale partials", async () => {
    const f = setup();
    await f.controller.start();
    f.receive({
      kind: "partial",
      text: "next line in progress",
      endOffsetMs: 300,
    });
    f.receive({ kind: "partial", text: "stale", endOffsetMs: 100 });
    f.receive({
      kind: "speech",
      id: "first",
      text: "first line",
      endOffsetMs: 200,
    });
    expect(f.controller.getState().text).toBe(
      "first line\nnext line in progress",
    );
    f.receive({
      kind: "turn",
      id: "turn1",
      text: "first line",
      endOffsetMs: 200,
    });
    await tick();
    expect(f.controller.getState().text).toBe("next line in progress");
  });

  it("manual Send asks Runtime to flush instead of treating partial text as final", async () => {
    const f = setup();
    await f.controller.start();
    f.receive({ kind: "partial", text: "draft", endOffsetMs: 100 });
    await f.controller.commit();
    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("disables automatic sends before exit drains the last final and preserves it", async () => {
    const f = setup();
    await f.controller.start();
    f.receive({ kind: "partial", text: "unsent", endOffsetMs: 100 });
    f.close.mockImplementationOnce(async () => {
      f.receive({
        kind: "turn",
        id: "last",
        text: "unsent full sentence",
        endOffsetMs: 150,
      });
    });
    await f.controller.pause();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.controller.getState()).toMatchObject({
      status: "paused",
      text: "unsent full sentence",
    });
  });

  it("retries a failed send with the same turn ID after releasing input", async () => {
    const send = vi
      .fn<(turn: { id: string; text: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Network unavailable"))
      .mockResolvedValue(undefined);
    const f = setup(send);
    await f.controller.start();
    f.receive({
      kind: "turn",
      id: "retry-key",
      text: "keep me",
      endOffsetMs: 100,
    });
    await tick();
    expect(f.controller.getState()).toMatchObject({
      status: "error",
      text: "keep me",
    });
    expect(f.close).toHaveBeenCalledOnce();
    await f.controller.retry();
    expect(send.mock.calls).toEqual([
      [{ id: "retry-key", text: "keep me" }],
      [{ id: "retry-key", text: "keep me" }],
    ]);
    expect(f.controller.getState().text).toBe("");
  });

  it("does not offer an ineffective message retry for an ASR failure", async () => {
    const f = setup();
    let closed!: () => void;
    f.close.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          closed = () => resolve(undefined);
        }),
    );
    await f.controller.start();
    f.fail(new Error("Lost input"));
    await f.controller.retry();
    const pending = f.controller.start();
    await tick();
    expect(f.open).toHaveBeenCalledOnce();
    closed();
    await pending;
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.controller.getState()).toMatchObject({
      status: "error",
      error: "Lost input",
      canRetry: false,
    });
  });

  it("bounds queued turns when the network cannot keep up and retains text", async () => {
    const f = setup(vi.fn(() => new Promise<void>(() => undefined)));
    await f.controller.start();
    for (let n = 1; n <= 8; n++)
      f.receive({
        kind: "turn",
        id: `turn${n}`,
        text: `message ${n}`,
        endOffsetMs: n * 100,
      });
    expect(f.controller.getState()).toMatchObject({ status: "error" });
    expect(f.controller.getState().text).toContain("message 8");
    expect(f.close).toHaveBeenCalledOnce();
  });
});
