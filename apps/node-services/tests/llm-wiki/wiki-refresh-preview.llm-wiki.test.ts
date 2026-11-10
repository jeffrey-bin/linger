import { afterEach, expect, it, vi } from "vitest";
import { streamWikiCandidateResponse } from "../../src/llm-wiki/wiki-refresh-preview.js";

afterEach(() => vi.useRealTimers());

it("sends the first page at once, then coalesces pages at three-minute boundaries, skips unchanged windows and sends completion immediately", async () => {
  vi.useFakeTimers();
  let finish!: (response: Response) => void;
  const final = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  let stage!: (path: string, markdown: string | null) => void;
  const response = streamWikiCandidateResponse(
    new AbortController().signal,
    (_, onPage) => {
      stage = onPage;
      return final;
    },
  );
  const reader = response.body!.getReader();
  const next = () =>
    reader
      .read()
      .then(({ value }) => JSON.parse(new TextDecoder().decode(value)));
  const received = vi.fn();
  await vi.advanceTimersByTimeAsync(360_000);
  stage("topics/a.md", "draft");
  await expect(next()).resolves.toEqual({
    kind: "preview",
    pages: { "topics/a.md": "draft" },
  });
  const first = next().then(received);
  stage("topics/a.md", "revised");
  stage("people/b.md", "complete");
  await vi.advanceTimersByTimeAsync(179_999);
  expect(received).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await first;
  expect(received).toHaveBeenCalledWith({
    kind: "preview",
    pages: { "topics/a.md": "revised", "people/b.md": "complete" },
  });
  const second = next().then(received);
  stage("topics/a.md", "revised");
  await vi.advanceTimersByTimeAsync(180_000);
  expect(received).toHaveBeenCalledTimes(1);
  stage("people/b.md", null);
  await vi.advanceTimersByTimeAsync(180_000);
  await second;
  expect(received).toHaveBeenLastCalledWith({
    kind: "preview",
    pages: { "topics/a.md": "revised" },
  });
  finish(Response.json({ pages: ["final"] }));
  await expect(next()).resolves.toEqual({
    kind: "final",
    status: 200,
    body: { pages: ["final"] },
  });
  await expect(reader.read()).resolves.toMatchObject({ done: true });
});

it("propagates cancellation to the generation", async () => {
  let signal!: AbortSignal;
  const response = streamWikiCandidateResponse(
    new AbortController().signal,
    async (current) => {
      signal = current;
      await new Promise<void>((resolve) =>
        current.addEventListener("abort", () => resolve(), { once: true }),
      );
      return Response.json({});
    },
  );
  await response.body!.cancel();
  expect(signal.aborted).toBe(true);
});
