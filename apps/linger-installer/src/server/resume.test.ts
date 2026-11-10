import { expect, test, vi } from "vitest";
import type { Instance } from "@linger/local-installation/instance";
import type { installNativeSource } from "@linger/local-installation/native-source";
import { resumeSourceInstance, type ResumeEngine } from "./resume.js";

const instance = {
  name: "desktop",
  mode: "source-native",
  origin: "http://localhost:3000",
  source: { repo: "/source" },
} as Instance;
const options = {
  home: "/home",
  sourceRepo: "/source",
  instanceName: "desktop",
  externalComputer: true,
  signal: new AbortController().signal,
  log: () => {},
};

const native = (run: ResumeEngine["run"], ready: boolean) => ({
  "source-native": { run, probe: async () => [{ ready }] },
});

test("starts the saved instance again without new input", async () => {
  const run = vi.fn<typeof installNativeSource>(async () => ({
    code: 0,
    state: "ready",
    message: "ok",
  }));
  const outcome = await resumeSourceInstance(options, {
    load: async () => instance,
    engines: native(run, false),
  });
  expect(outcome).toMatchObject({
    code: 0,
    details: { origin: "http://localhost:3000" },
  });
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "desktop",
      home: "/home",
      repo: "/source",
      externalComputer: true,
    }),
  );
  expect(run.mock.calls[0]![0]).not.toHaveProperty("password");
});

test("leaves running services alone", async () => {
  const run = vi.fn();
  expect(
    await resumeSourceInstance(options, {
      load: async () => instance,
      engines: native(run, true),
      pending: async () => false,
    }),
  ).toMatchObject({ code: 0, details: { origin: instance.origin } });
  expect(run).not.toHaveBeenCalled();
});

test("restarts running services for a changed user.env", async () => {
  const run = vi.fn<ResumeEngine["run"]>(async () => ({
    code: 0,
    state: "ready",
    message: "ok",
  }));
  await resumeSourceInstance(options, {
    load: async () => instance,
    engines: native(run, true),
    pending: async () => true,
  });
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({ repo: "/source" }),
  );
});

test("moves running services to a new source tree", async () => {
  const run = vi.fn<ResumeEngine["run"]>(async () => ({
    code: 0,
    state: "ready",
    message: "ok",
  }));
  await resumeSourceInstance(options, {
    load: async () =>
      ({ ...instance, source: { repo: "/old-source" } }) as Instance,
    engines: native(run, true),
  });
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({ repo: "/source" }),
  );
});

test("needs an installed source instance", async () => {
  expect(
    await resumeSourceInstance(options, {
      load: async () => ({ ...instance, source: undefined }),
    }),
  ).toMatchObject({ code: 4 });
  expect(
    await resumeSourceInstance(options, { load: async () => undefined }),
  ).toMatchObject({ code: 4 });
});
