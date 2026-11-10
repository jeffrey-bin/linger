import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useComputerConnectionStatus } from "./computer-connection-status";

function ComputerConnectionStatus({
  computerId,
  status,
}: {
  computerId: string;
  status: "online" | "offline";
}) {
  return (
    <span role="status">{useComputerConnectionStatus(computerId, status)}</span>
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("keeps reconnect churn stable and only settles after sustained availability", () => {
  vi.useFakeTimers();
  const { rerender } = render(
    <ComputerConnectionStatus computerId="old-ts" status="online" />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("online");
  for (let iteration = 0; iteration < 5; iteration++) {
    rerender(<ComputerConnectionStatus computerId="old-ts" status="offline" />);
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    rerender(<ComputerConnectionStatus computerId="old-ts" status="online" />);
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByRole("status")).toHaveTextContent("reconnecting");
  }
  act(() => {
    vi.advanceTimersByTime(15_000);
  });
  expect(screen.getByRole("status")).toHaveTextContent("online");
  rerender(<ComputerConnectionStatus computerId="old-ts" status="offline" />);
  act(() => {
    vi.advanceTimersByTime(15_000);
  });
  expect(screen.getByRole("status")).toHaveTextContent("offline");
});

it("does not resubscribe on status or unrelated renders and resets on identity change", () => {
  vi.useFakeTimers();
  const intervals = vi.spyOn(globalThis, "setInterval");
  const clear = vi.spyOn(globalThis, "clearInterval");
  const { rerender, unmount } = render(
    <ComputerConnectionStatus computerId="old-ts" status="online" />,
  );
  rerender(<ComputerConnectionStatus computerId="old-ts" status="offline" />);
  rerender(<ComputerConnectionStatus computerId="old-ts" status="offline" />);
  expect(intervals).toHaveBeenCalledTimes(1);
  expect(clear).not.toHaveBeenCalled();
  rerender(<ComputerConnectionStatus computerId="new-go" status="online" />);
  expect(screen.getByRole("status")).toHaveTextContent("online");
  expect(intervals).toHaveBeenCalledTimes(2);
  expect(clear).toHaveBeenCalledTimes(1);
  unmount();
  expect(clear).toHaveBeenCalledTimes(2);
});
