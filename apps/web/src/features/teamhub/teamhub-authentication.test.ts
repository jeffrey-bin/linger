import { describe, expect, it, vi } from "vitest";

import { createTeamHubAuthenticationSignals } from "./teamhub-authentication";

describe("TeamHub authentication signals", () => {
  it("delivers a local report once in every tab without rebroadcast loops", () => {
    const network = new FakeBroadcastNetwork();
    const first = createTeamHubAuthenticationSignals({
      channelFactory: network.createChannel,
    });
    const second = createTeamHubAuthenticationSignals({
      channelFactory: network.createChannel,
    });
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    first.subscribe(firstListener);
    second.subscribe(secondListener);

    first.publish("authentication-required", "session-expired");

    expect(firstListener).toHaveBeenCalledWith(
      "authentication-required",
      "session-expired",
    );
    expect(secondListener).toHaveBeenCalledWith(
      "authentication-required",
      "session-expired",
    );
    expect(network.posts).toBe(1);
    first.close();
    second.close();
  });

  it("broadcasts deliberate login without replaying it in the originating tab", () => {
    const network = new FakeBroadcastNetwork();
    const first = createTeamHubAuthenticationSignals({
      channelFactory: network.createChannel,
    });
    const second = createTeamHubAuthenticationSignals({
      channelFactory: network.createChannel,
    });
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    first.subscribe(firstListener);
    second.subscribe(secondListener);

    first.broadcast("authenticated");

    expect(firstListener).not.toHaveBeenCalled();
    expect(secondListener).toHaveBeenCalledWith("authenticated");
    first.close();
    second.close();
  });

  it("ignores unknown protocol versions and event kinds", () => {
    const network = new FakeBroadcastNetwork();
    const signals = createTeamHubAuthenticationSignals({
      channelFactory: network.createChannel,
    });
    const listener = vi.fn();
    signals.subscribe(listener);

    network.dispatch({ kind: "authenticated", version: 2 });
    network.dispatch({ kind: "unknown", version: 1 });

    expect(listener).not.toHaveBeenCalled();
    signals.close();
  });

  it("accepts version one messages without a reason for older tabs", () => {
    const network = new FakeBroadcastNetwork();
    const signals = createTeamHubAuthenticationSignals({
      channelFactory: network.createChannel,
    });
    const listener = vi.fn();
    signals.subscribe(listener);

    network.dispatch({ kind: "authentication-required", version: 1 });

    expect(listener).toHaveBeenCalledWith("authentication-required");
    signals.close();
  });
});

class FakeBroadcastNetwork {
  readonly channels = new Set<FakeBroadcastChannel>();
  posts = 0;

  readonly createChannel = () => {
    const channel = new FakeBroadcastChannel(this);
    this.channels.add(channel);
    return channel;
  };

  dispatch(message: unknown) {
    for (const channel of this.channels) {
      channel.dispatch(message);
    }
  }
}

class FakeBroadcastChannel {
  private listener?: (event: MessageEvent<unknown>) => void;

  constructor(private readonly network: FakeBroadcastNetwork) {}

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ) {
    this.listener = listener;
  }

  close() {
    this.network.channels.delete(this);
  }

  dispatch(message: unknown) {
    this.listener?.({ data: message } as MessageEvent<unknown>);
  }

  postMessage(message: { kind: string; version: number }) {
    this.network.posts += 1;
    for (const channel of this.network.channels) {
      if (channel !== this) {
        channel.dispatch(message);
      }
    }
  }
}
