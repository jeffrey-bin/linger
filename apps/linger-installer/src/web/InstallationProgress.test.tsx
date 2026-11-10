// @vitest-environment jsdom
import { expect, test, vi } from "vitest";
import { render } from "@testing-library/react";
import { InstallationProgress } from "./InstallationProgress.js";
import type { InstallationJob } from "./api.js";

test("a single bar does not advance with time or regress when the next download starts; a new job resets it", () => {
  const job: InstallationJob = {
    id: "one",
    instance: "default",
    state: "running",
    stage: "runtime",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    lastSequence: 1,
    stages: [
      {
        id: "preflight",
        state: "succeeded",
        at: new Date(0).toISOString(),
        message: "",
      },
      {
        id: "runtime",
        state: "running",
        at: new Date(0).toISOString(),
        message: "Downloading runtime",
        progress: { completed: 800, total: 1000, unit: "bytes" },
      },
    ],
  };
  const element = (input: InstallationJob, now: number) => (
    <InstallationProgress job={input} now={now} />
  );
  const view = render(element(job, 0));
  const value = () =>
    view.getByRole("progressbar").getAttribute("aria-valuenow");
  expect(value()).toBe("90");
  view.rerender(element(job, 60000));
  expect(value()).toBe("90");
  const next = structuredClone(job);
  next.stages[1]!.progress = { completed: 10, total: 2000, unit: "bytes" };
  view.rerender(element(next, 62000));
  expect(value()).toBe("90");
  next.id = "two";
  next.stages = next.stages.map((stage) => ({
    ...stage,
    state: "pending",
    progress: undefined,
  }));
  view.rerender(element(next, 64000));
  expect(value()).toBe("0");
  view.unmount();
});

test("restores the same job progress after a page remount during the next download", () => {
  const stored = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  const job: InstallationJob = {
    id: "remount-proof",
    instance: "default",
    state: "running",
    stage: "runtime",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    lastSequence: 1,
    stages: [
      {
        id: "runtime",
        state: "running",
        at: new Date(0).toISOString(),
        message: "Downloading",
        progress: { completed: 900, total: 1000, unit: "bytes" },
      },
    ],
  };
  const element = () => <InstallationProgress job={job} now={0} />;
  let view = render(element());
  expect(view.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
    "90",
  );
  job.stages[0]!.progress = { completed: 10, total: 2000, unit: "bytes" };
  view.rerender(element());
  view.unmount();
  view = render(element());
  expect(view.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
    "90",
  );
  view.unmount();
  vi.unstubAllGlobals();
});

test("native source preparation uses the existing progress view without image wording", () => {
  const job: InstallationJob = {
    id: "native-progress",
    instance: "native",
    state: "running",
    stage: "images",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    lastSequence: 1,
    stages: [
      {
        id: "images",
        state: "running",
        at: new Date(0).toISOString(),
        message: "",
      },
    ],
  };
  const view = render(<InstallationProgress job={job} now={0} />);
  expect(
    view.getAllByText(/Preparing native source services/).length,
  ).toBeGreaterThan(0);
  expect(view.queryByText(/Building source development images/)).toBeNull();
  view.unmount();
});
