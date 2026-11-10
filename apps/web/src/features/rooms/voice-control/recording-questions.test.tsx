import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { RecordingAnswers } from "./recording-questions";

it("reveals a new question and its answer without pulling a reader away from history", () => {
  const props = {
    items: [],
    onRetry: vi.fn(),
    onRetryTask: vi.fn(),
    recordingStartMs: 0,
    taskState: () => undefined,
  };
  const { rerender } = render(<RecordingAnswers {...props} />);
  const list = screen.getByRole("list", {
    name: "Answers about this recording",
  });
  Object.defineProperties(list, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 200 },
  });
  list.scrollTop = 0;
  fireEvent.scroll(list);
  rerender(
    <RecordingAnswers
      {...props}
      pending={{ question: "What happened?", failed: false }}
    />,
  );
  expect(list.scrollTop).toBe(1000);

  Object.defineProperty(list, "scrollHeight", {
    configurable: true,
    value: 1200,
  });
  const answer = {
    id: "q1",
    kind: "answer" as const,
    question: "What happened?",
    answer: "A result",
    answered: true,
    cutoff_offset_ms: 0,
    sources: [],
    created_at: "2026-11-05T00:00:00Z",
  };
  rerender(<RecordingAnswers {...props} items={[answer]} />);
  expect(list.scrollTop).toBe(1200);

  list.scrollTop = 100;
  fireEvent.scroll(list);
  Object.defineProperty(list, "scrollHeight", {
    configurable: true,
    value: 1400,
  });
  rerender(
    <RecordingAnswers {...props} items={[answer, { ...answer, id: "q2" }]} />,
  );
  expect(list.scrollTop).toBe(100);
});
