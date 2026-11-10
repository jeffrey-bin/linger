import { act, render, screen } from "@testing-library/react";
import { Component, type ReactNode, useState } from "react";
import { expect, it } from "vitest";
import { RoomPresentationBoundary } from "./room-presentation-boundary";

function deferred() {
  let resolve!: (snapshot: { initialRoomSeq: number }) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<{ initialRoomSeq: number }>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function Draft({ seq }: { seq: number }) {
  const [draft] = useState(`draft at ${seq}`);
  return <p>{draft}</p>;
}
function surface(presentation: Promise<{ initialRoomSeq: number }>) {
  return (
    <RoomPresentationBoundary
      presentation={presentation}
      fallback={<p>Loading Room</p>}
    >
      {({ initialRoomSeq }) => <Draft seq={initialRoomSeq} />}
    </RoomPresentationBoundary>
  );
}

it("keeps chat unmounted until its authorized snapshot is ready, then preserves its state", async () => {
  const pending = deferred();
  const view = render(surface(pending.promise));
  expect(screen.getByText("Loading Room")).toBeVisible();
  expect(screen.queryByText(/draft at/)).toBeNull();
  await act(async () => pending.resolve({ initialRoomSeq: 42 }));
  const node = screen.getByText("draft at 42");
  view.rerender(surface(pending.promise));
  expect(screen.getByText("draft at 42")).toBe(node);
});

it("never displays an old snapshot after switching to another pending Room", async () => {
  const old = deferred();
  const next = deferred();
  const view = render(surface(old.promise));
  view.rerender(surface(next.promise));
  await act(async () => old.resolve({ initialRoomSeq: 1 }));
  expect(screen.getByText("Loading Room")).toBeVisible();
  expect(screen.queryByText("draft at 1")).toBeNull();
  await act(async () => next.resolve({ initialRoomSeq: 2 }));
  expect(screen.getByText("draft at 2")).toBeVisible();
});

it("does not reuse a fulfilled Room snapshot for a new pending source", async () => {
  const old = deferred();
  const next = deferred();
  const view = render(surface(old.promise));
  await act(async () => old.resolve({ initialRoomSeq: 1 }));
  view.rerender(surface(next.promise));
  expect(screen.queryByText("draft at 1")).toBeNull();
  expect(screen.getByText("Loading Room")).toBeVisible();
});

class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <p>Room denied</p> : this.props.children;
  }
}
it("passes a current authorization failure to the route error boundary", async () => {
  const pending = deferred();
  render(<ErrorBoundary>{surface(pending.promise)}</ErrorBoundary>);
  await act(async () => pending.reject(new Error("denied")));
  expect(screen.getByText("Room denied")).toBeVisible();
  expect(screen.queryByText(/draft at/)).toBeNull();
});

it("ignores a rejection from an abandoned Room", async () => {
  const old = deferred();
  const next = deferred();
  const view = render(surface(old.promise));
  view.rerender(surface(next.promise));
  await act(async () => old.reject(new Error("old request failed")));
  await act(async () => next.resolve({ initialRoomSeq: 3 }));
  expect(screen.getByText("draft at 3")).toBeVisible();
});
