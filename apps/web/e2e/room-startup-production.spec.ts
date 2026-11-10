import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { RoomDocumentE2EHarnessClient } from "./room-document-e2e-harness-client";

interface StartupMarks {
  historyMs?: number;
  composerMs?: number;
  panel?: {
    clicked: number;
    shell?: number;
    content?: number;
    expanded?: number;
  };
  longTasks: Array<{ start: number; duration: number }>;
}
declare global {
  interface Window {
    __roomStartup: StartupMarks;
  }
}

test("production Room startup records cold and warm document loads", async ({
  page,
  context,
  request,
}, testInfo) => {
  test.skip(
    process.env.VERIFY_ROOM_STARTUP_PRODUCTION !== "1",
    "Requires owned production Web and real services",
  );
  test.setTimeout(300_000);
  const samples = Number(process.env.ROOM_STARTUP_SAMPLES ?? 5);
  const latency = Number(process.env.ROOM_STARTUP_LATENCY_MS ?? 150);
  expect(Number.isInteger(samples) && samples > 0 && samples <= 20).toBe(true);
  expect(Number.isFinite(latency) && latency >= 0 && latency <= 1000).toBe(
    true,
  );
  const manifest = JSON.parse(
    await readFile(
      new URL("../dist/.vite/manifest.json", import.meta.url),
      "utf8",
    ),
  );
  const sidebarPath = `/${manifest["src/features/rooms/task-sidebar/room-task-sidebar.tsx"].file}`;
  const filePanelChunk =
    manifest["src/features/rooms/task-sidebar/adapters/file-panel-tab.tsx"];
  expect(filePanelChunk?.isDynamicEntry).toBe(true);
  const filePanelPath = `/${filePanelChunk.file}`;
  const harness = new RoomDocumentE2EHarnessClient(request);
  const fixture = await harness.reset();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await writeFile(
      testInfo.outputPath("doctor.txt"),
      execFileSync("apps/web/e2e/doctor.sh", {
        encoding: "utf8",
      }),
    );
    await page.goto("/login");
    await page.getByLabel("Email").fill("alice@example.com");
    await page
      .getByLabel("Password", { exact: true })
      .fill("teamhub-dev-alice");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/t\/[^/]+\//);
    const directoryPath = `/v0/tenants/${fixture.tenant_id}/agents`;
    const directory = await page.request.get(directoryPath + "?limit=200");
    expect(directory.ok()).toBe(true);
    const agents = (await directory.json()).items;
    // The single Human sees all eight seeded Agents, including the one that
    // used to be outside the directory's former multi-Human scope.
    expect(agents).toHaveLength(8);
    expect(
      agents.reduce(
        (sum: number, agent: { skill_bindings: unknown[] }) =>
          sum + agent.skill_bindings.length,
        0,
      ),
    ).toBe(8 * 13 + 6); // Thirteen defaults each; three explicit bindings on two Agents.
    const target = agents.find(
      (agent: { actor: { display_name: string } }) =>
        agent.actor.display_name === "Directory Agent 1",
    );
    expect(target).toBeTruthy();
    const opened = await page.request.post(
      `/v0/tenants/${fixture.tenant_id}/direct-rooms`,
      { data: { peer_actor_id: target.actor.id } },
    );
    expect(opened.ok(), await opened.text()).toBe(true);
    const room = await opened.json();
    const roomUrl = `/t/${fixture.tenant_id}/rooms/${room.id}/chat`;
    let lastMessageId = "";
    for (let index = 0; index < 13; index++) {
      const message = await page.request.post(`/v0/rooms/${room.id}/messages`, {
        headers: { "Idempotency-Key": `startup-message-${index}` },
        data: {
          raw_message: `Startup history ${index}: production build with real TeamHub and PostgreSQL.`,
          segments: [
            {
              type: "text",
              content: `Startup history ${index}: production build with real TeamHub and PostgreSQL.`,
            },
          ],
        },
      });
      expect(message.status(), await message.text()).toBe(201);
      lastMessageId = (await message.json()).id;
    }
    await page.addInitScript(() => {
      performance.setResourceTimingBufferSize(2000);
      const marks: StartupMarks = { longTasks: [] };
      window.__roomStartup = marks;
      document.addEventListener(
        "click",
        (event) => {
          if (
            event.target instanceof Element &&
            event.target.closest('button[aria-label="Show sidebar"]')
          ) {
            marks.panel = { clicked: performance.now() };
          }
        },
        true,
      );
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          marks.longTasks.push({
            start: entry.startTime,
            duration: entry.duration,
          });
      }).observe({ type: "longtask", buffered: true });
      const inspect = () => {
        const composer = document.querySelector<HTMLTextAreaElement>(
          '[aria-label="Message Room"]',
        );
        if (
          !marks.composerMs &&
          composer &&
          !composer.disabled &&
          composer.getBoundingClientRect().height > 0
        )
          marks.composerMs = performance.now();
        if (
          !marks.historyMs &&
          [...document.querySelectorAll("article")].some(
            (node) =>
              node.textContent?.includes("Startup history 12") &&
              node.getBoundingClientRect().height > 0,
          )
        )
          marks.historyMs = performance.now();
        if (marks.panel && !marks.panel.expanded) {
          const shell = document.querySelector<HTMLElement>(
            'aside[aria-label="Loading panel sidebar"],aside[aria-label="Panel sidebar"]',
          );
          const shown =
            shell?.dataset.open === "true" &&
            shell.getBoundingClientRect().left < innerWidth - 1;
          if (shown && !marks.panel.shell)
            marks.panel.shell = performance.now();
          const content = shell?.querySelector<HTMLElement>(
            '[data-testid="panel-tab-agent-info"]',
          );
          if (
            shown &&
            content &&
            content.getBoundingClientRect().height > 0 &&
            content.textContent?.includes("Directory Agent 1")
          ) {
            marks.panel.content ??= performance.now();
            if (shell.getBoundingClientRect().right <= innerWidth + 1)
              marks.panel.expanded = performance.now();
          }
        }
        requestAnimationFrame(inspect);
      };
      requestAnimationFrame(inspect);
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    const measurements = [];
    for (let sample = 0; sample < samples; sample++) {
      for (const cache of ["cold-http", "warm-http"] as const) {
        await page.goto("about:blank");
        if (cache === "cold-http") await cdp.send("Network.clearBrowserCache");
        await page.goto(roomUrl, { waitUntil: "domcontentloaded" });
        const composer = page.getByRole("textbox", {
          name: "Message Room",
          exact: true,
        });
        await expect(composer).toBeEditable();
        await expect(
          page.getByRole("article").filter({ hasText: "Startup history 12" }),
        ).toBeVisible();
        await expect
          .poll(() =>
            page.evaluate(() =>
              Boolean(
                window.__roomStartup.composerMs &&
                window.__roomStartup.historyMs,
              ),
            ),
          )
          .toBe(true);
        await composer.fill("Local startup draft");
        await expect(composer).toHaveValue("Local startup draft");
        await composer.fill("");
        // Collect requests started before readiness, including any finishing just after it.
        await page.waitForTimeout(300);
        const measured = await page.evaluate(() => {
          const marks = window.__roomStartup;
          const readyMs = Math.max(marks.historyMs!, marks.composerMs!);
          const resources = performance
            .getEntriesByType("resource")
            .map((raw) => {
              const entry = raw as PerformanceResourceTiming;
              return {
                path: new URL(entry.name).pathname,
                start: entry.startTime,
                end: entry.responseEnd,
                bytes: entry.decodedBodySize,
                transfer: entry.transferSize,
              };
            });
          const scripts = resources.filter(
            (entry) => entry.path.endsWith(".js") && entry.start <= readyMs,
          );
          return {
            ...marks,
            readyMs,
            resources,
            scripts,
            scriptBytes: scripts.reduce((sum, entry) => sum + entry.bytes, 0),
            longTasks: marks.longTasks.filter((task) => task.start <= readyMs),
          };
        });
        const agentsRequest = measured.resources.find(
          (entry) => entry.path === directoryPath,
        );
        const messagesRequest = measured.resources.find(
          (entry) => entry.path === `/v0/rooms/${room.id}/messages`,
        );
        expect(agentsRequest).toBeTruthy();
        expect(messagesRequest).toBeTruthy();
        expect(
          measured.scripts.some((entry) =>
            /\/assets\/index-[^/]+\.js$/.test(entry.path),
          ),
        ).toBe(true);
        expect(
          measured.resources.some(
            (entry) =>
              entry.path.includes("/@vite/") || entry.path.endsWith(".tsx"),
          ),
        ).toBe(false);
        measurements.push({
          sample,
          cache,
          ...measured,
          directoryStartMs: agentsRequest!.start,
          directoryDurationMs: agentsRequest!.end - agentsRequest!.start,
          messagesEndMs: messagesRequest!.end,
        });
        await page.screenshot({
          path: testInfo.outputPath(`${cache}-${sample}.png`),
        });
        console.log(
          JSON.stringify({
            sample,
            cache,
            readyMs: measured.readyMs,
            directoryStartMs: agentsRequest!.start,
            scriptBytes: measured.scriptBytes,
          }),
        );
      }
    }
    // Check the first panel interaction too: startup gains must not hide a broken panel.
    const panelOpenMs: number[] = [];
    const panelTimings = [];
    for (const delayMs of [0, 1000, 3000]) {
      for (let sample = 0; sample < Math.min(samples, 3); sample++) {
        await page.goto("about:blank");
        await cdp.send("Network.clearBrowserCache");
        await page.goto(roomUrl, { waitUntil: "domcontentloaded" });
        const composer = page.getByRole("textbox", {
          name: "Message Room",
          exact: true,
        });
        await page.waitForFunction(() =>
          Boolean(
            window.__roomStartup.composerMs && window.__roomStartup.historyMs,
          ),
        );
        await expect(composer).toBeEditable();
        await composer.fill("Keep this draft when opening the panel");
        await page.evaluate(async (delay) => {
          const ready = Math.max(
            window.__roomStartup.composerMs!,
            window.__roomStartup.historyMs!,
          );
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, ready + delay - performance.now())),
          );
        }, delayMs);
        const panelStarted = await page.evaluate(() => performance.now());
        await page
          .getByRole("button", { name: "Show sidebar", exact: true })
          .click();
        await expect(page.getByTestId("panel-tab-agent-info")).toBeVisible();
        await expect(page.getByTestId("panel-tab-agent-info")).toContainText(
          "Directory Agent 1",
        );
        const automationMs =
          (await page.evaluate(() => performance.now())) - panelStarted;
        if (delayMs === 0) panelOpenMs.push(automationMs);
        await page.waitForFunction(() =>
          Boolean(window.__roomStartup.panel?.expanded),
        );
        const timing = await page.evaluate((resourcePath) => {
          const marks = window.__roomStartup;
          const panel = marks.panel!;
          const ready = Math.max(marks.composerMs!, marks.historyMs!);
          const preload = performance
            .getEntriesByType("resource")
            .find((entry) => new URL(entry.name).pathname === resourcePath) as
            | PerformanceResourceTiming
            | undefined;
          return {
            clickAfterReadyMs: panel.clicked - ready,
            shellMs: panel.shell! - panel.clicked,
            contentMs: panel.content! - panel.clicked,
            expandedMs: panel.expanded! - panel.clicked,
            resources: performance
              .getEntriesByType("resource")
              .map((raw) => {
                const entry = raw as PerformanceResourceTiming;
                return {
                  path: new URL(entry.name).pathname,
                  startAfterReadyMs: entry.startTime - ready,
                  endAfterReadyMs: entry.responseEnd - ready,
                };
              })
              .filter((entry) => entry.startAfterReadyMs >= 0),
            longTasks: marks.longTasks.filter(
              (task) => task.start >= ready && task.start < panel.content!,
            ),
            prefetchAfterReadyMs: preload ? preload.startTime - ready : null,
            prefetchEndAfterReadyMs: preload
              ? preload.responseEnd - ready
              : null,
          };
        }, sidebarPath);
        panelTimings.push({ delayMs, sample, ...timing, automationMs });
        console.log(
          JSON.stringify({
            panel: true,
            delayMs,
            sample,
            shellMs: timing.shellMs,
            contentMs: timing.contentMs,
            clickAfterReadyMs: timing.clickAfterReadyMs,
          }),
        );
        expect(
          await page.evaluate(
            (resourcePath) =>
              performance
                .getEntriesByType("resource")
                .some((entry) => new URL(entry.name).pathname === resourcePath),
            filePanelPath,
          ),
        ).toBe(false);
        await page.screenshot({
          path: testInfo.outputPath(`panel-${delayMs}-${sample}.png`),
        });
        await page
          .getByRole("button", { name: "Hide sidebar", exact: true })
          .click();
        await expect(composer).toHaveValue(
          "Keep this draft when opening the panel",
        );
        await composer.fill("");
      }
    }
    await writeFile(
      testInfo.outputPath("startup-measurements.json"),
      JSON.stringify(
        {
          conditions: {
            samples,
            latencyMs: latency,
            cpuThrottle: 1,
            browserVersion: context.browser()?.version(),
            frontend: "production static host",
            data: "real disposable TeamHub/PostgreSQL",
            messages: 13,
            agents: agents.length,
            skillBindings: agents.reduce(
              (sum: number, agent: { skill_bindings?: unknown[] }) =>
                sum + (agent.skill_bindings?.length ?? 0),
              0,
            ),
          },
          measurements,
          panelOpenMs,
          panelTimings,
          errors,
        },
        null,
        2,
      ),
    );
    expect(errors).toEqual([]);
    for (const row of measurements)
      expect(row.directoryStartMs).toBeLessThan(row.messagesEndMs);
    for (const row of measurements)
      expect(
        row.scripts.filter((entry) => entry.path === filePanelPath),
      ).toEqual([]);
    for (const row of measurements) {
      expect(row.scripts.filter((entry) => entry.path === sidebarPath)).toEqual(
        [],
      );
    }
    // Delay real code delivery to prove that the loading shell remains useful.
    let releaseCode!: () => void;
    const codeGate = new Promise<void>((resolve) => {
      releaseCode = resolve;
    });
    await page.route(`**${sidebarPath}`, async (route) => {
      const response = await route.fetch();
      await codeGate;
      await route.fulfill({ response });
    });
    try {
      await page.goto("about:blank");
      await cdp.send("Network.clearBrowserCache");
      await page.goto(roomUrl);
      const composer = page.getByRole("textbox", {
        name: "Message Room",
        exact: true,
      });
      await expect(composer).toBeEditable();
      await page
        .getByRole("button", { name: "Show sidebar", exact: true })
        .click();
      const shell = page.getByRole("complementary", {
        name: "Loading panel sidebar",
      });
      await expect(shell).toHaveAttribute("data-open", "true");
      await expect(shell.getByRole("status")).toHaveText("Loading sidebar...");
      await composer.fill("Typing while sidebar code waits");
      await expect(composer).toHaveValue("Typing while sidebar code waits");
      await page.screenshot({
        path: testInfo.outputPath("sidebar-code-held.png"),
      });
      await shell.getByRole("button", { name: "Hide sidebar" }).click();
      await expect(shell).toHaveCount(0);
      await page
        .getByRole("button", { name: "Show sidebar", exact: true })
        .click();
      await expect(shell).toBeVisible();
      await composer.fill("Typing after reopening the loading panel");
      await expect(composer).toBeFocused();
      releaseCode();
      await expect(page.getByTestId("panel-tab-agent-info")).toBeVisible();
      await expect(composer).toHaveValue(
        "Typing after reopening the loading panel",
      );
      await expect(composer).toBeFocused();
    } finally {
      releaseCode();
      await page.unrouteAll({ behavior: "wait" });
    }
    // Opening saved tabs and active-peer composition do not wait for the directory.
    await page.addInitScript(() => {
      window.requestIdleCallback = () => 1;
    });
    let releaseDirectory!: () => void;
    let directoryHeld = false;
    const directoryGate = new Promise<void>((resolve) => {
      releaseDirectory = resolve;
    });
    await page.route(`**${directoryPath}?*`, async (route) => {
      const response = await route.fetch();
      directoryHeld = true;
      await directoryGate;
      await route.fulfill({ response });
    });
    try {
      await page.goto("about:blank");
      await cdp.send("Network.clearBrowserCache");
      await page.goto(`${roomUrl}?message=${lastMessageId}`);
      await expect.poll(() => directoryHeld).toBe(true);
      await page
        .getByRole("button", { name: "Show sidebar", exact: true })
        .click();
      await expect
        .poll(() =>
          page.evaluate(
            (resourcePath) =>
              performance
                .getEntriesByType("resource")
                .some((entry) => new URL(entry.name).pathname === resourcePath),
            sidebarPath,
          ),
        )
        .toBe(true);
      const composer = page.getByRole("textbox", {
        name: "Message Room",
        exact: true,
      });
      await expect(composer).toBeEditable();
      const body = "Sent while the Agent directory remains held";
      await composer.fill(body);
      const sent = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === `/v0/rooms/${room.id}/messages`,
      );
      await composer.press("Enter");
      const sentResponse = await sent;
      expect(sentResponse.status()).toBe(201);
      const sentMessage = await sentResponse.json();
      await expect(
        page.getByRole("article").filter({ hasText: body }),
      ).toHaveCount(1);
      const persisted = await page.request.get(
        `/v0/rooms/${room.id}/messages?limit=50`,
      );
      expect(persisted.ok()).toBe(true);
      // Direct Room sending adds the peer mention to the persisted text.
      const matchingMessages = (await persisted.json()).items.filter(
        (message: { raw_message: string }) =>
          message.raw_message.includes(body),
      );
      expect(matchingMessages).toHaveLength(1);
      expect(matchingMessages[0]).toMatchObject({
        id: sentMessage.id,
        room_id: room.id,
      });
      await composer.fill("Keep this draft when the directory arrives");
      await expect(composer).toBeFocused();
      const originalComposer = await composer.elementHandle();
      await page.screenshot({
        path: testInfo.outputPath("directory-held-message-sent.png"),
      });
      const directoryArrived = page.waitForResponse(
        (response) => new URL(response.url()).pathname === directoryPath,
      );
      releaseDirectory();
      const directoryResponse = await directoryArrived;
      expect(directoryResponse.ok()).toBe(true);
      await directoryResponse.finished();
      await expect(
        page.getByRole("complementary", {
          name: "Panel sidebar",
          exact: true,
        }),
      ).toBeVisible();
      await expect(composer).toBeEditable();
      await expect(composer).toHaveValue(
        "Keep this draft when the directory arrives",
      );
      await expect(composer).toBeFocused();
      expect(
        await composer.evaluate(
          (node, original) => node === original,
          originalComposer,
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath("saved-panel-reopened.png"),
      });
      await writeFile(
        testInfo.outputPath("sidebar-functional-proof.json"),
        JSON.stringify(
          {
            realCodeResponseHeld: true,
            typedWhileLoading: true,
            closedAndReopenedWhileLoading: true,
            focusAndDraftRetained: true,
            savedPanelOpenedBeforeDirectoryAndWithoutIdle: true,
            sentBeforeDirectory: true,
            messagePersistedExactlyOnce: true,
            composerAndDraftRetainedAfterDirectory: true,
          },
          null,
          2,
        ),
      );
    } finally {
      releaseDirectory();
      await page.unrouteAll({ behavior: "wait" });
    }
    expect(errors).toEqual([]);
  } finally {
    await harness.cleanup();
  }
});
