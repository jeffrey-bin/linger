import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import {
  SharedStreamingStatus,
  SharedStreamingStatusProvider,
} from "./shared-streaming-status";

it("mirrors both sources, updates and removes them together, and keeps source actions", () => {
  const stopChat = vi.fn();
  const stopThread = vi.fn();
  function View({
    status = "Thinking",
    threadOpen = true,
  }: {
    status?: string;
    threadOpen?: boolean;
  }) {
    return (
      <SharedStreamingStatusProvider>
        <section aria-label="Chat status">
          <SharedStreamingStatus surface="chat">
            <button onClick={stopChat}>Stop Chat Agent</button>
          </SharedStreamingStatus>
        </section>
        {threadOpen && (
          <section aria-label="Thread status">
            <SharedStreamingStatus surface="thread">
              {status && <button onClick={stopThread}>{status}</button>}
            </SharedStreamingStatus>
          </section>
        )}
      </SharedStreamingStatusProvider>
    );
  }
  const { rerender } = render(<View />);
  const chat = within(screen.getByRole("region", { name: "Chat status" }));
  const thread = within(screen.getByRole("region", { name: "Thread status" }));
  expect(chat.getByText("Thinking")).toBeVisible();
  expect(thread.getByText("Thinking")).toBeVisible();
  fireEvent.click(chat.getByText("Thinking"));
  fireEvent.click(thread.getByText("Stop Chat Agent"));
  expect(stopThread).toHaveBeenCalledTimes(1);
  expect(stopChat).toHaveBeenCalledTimes(1);

  rerender(<View status="Running tool" />);
  expect(chat.getByText("Running tool")).toBeVisible();
  expect(thread.getByText("Running tool")).toBeVisible();
  rerender(<View status="" />);
  expect(screen.queryByText("Running tool")).not.toBeInTheDocument();
  expect(screen.getAllByText("Stop Chat Agent")).toHaveLength(2);

  rerender(<View threadOpen={false} />);
  expect(chat.queryByText("Thinking")).not.toBeInTheDocument();
  expect(screen.getAllByText("Stop Chat Agent")).toHaveLength(1);
  rerender(<View />);
  expect(screen.getAllByText("Thinking")).toHaveLength(2);
});

it("renders standalone status without the Room provider", () => {
  render(
    <SharedStreamingStatus surface="thread">Working</SharedStreamingStatus>,
  );
  expect(screen.getByText("Working")).toBeVisible();
});
