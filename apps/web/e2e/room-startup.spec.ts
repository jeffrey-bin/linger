import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { blockExternalFonts } from "./room-document-collaboration-test-support";
import { RoomDocumentE2EHarnessClient } from "./room-document-e2e-harness-client";

async function signIn(page: Page) {
  await blockExternalFonts(page);
  await page.goto("/login");
  await page.getByLabel("Email").fill("alice@example.com");
  await page.getByLabel("Password", { exact: true }).fill("teamhub-dev-alice");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/t\/[^/]+\//);
}

test.afterEach(async ({ request }) => {
  await new RoomDocumentE2EHarnessClient(request).cleanup();
});

test("Room startup keeps chat usable while auxiliary services load", async ({
  page,
  browser,
  request,
  baseURL,
}, testInfo) => {
  test.setTimeout(120_000);
  // Reset also restarts Runtime after a preceding recovery test stopped it.
  const fixture = await new RoomDocumentE2EHarnessClient(request).reset();
  if (process.env.VERIFY_LINGER_EVIDENCE) {
    await test.step("Doctor: verify this run's owned services", async () => {
      const output = execFileSync("apps/web/e2e/doctor.sh", {
        encoding: "utf8",
      });
      await writeFile(testInfo.outputPath("doctor.txt"), output);
    });
  }
  const roomUrl = `/t/${fixture.tenant_id}/rooms/${fixture.room_id}/chat`;
  const marker = `Startup proof ${Date.now()}`;
  const draft = `${marker} preserved draft`;
  const timings: Record<string, number> = {};
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await test.step("Sign in and persist a scrollable conversation through the real composer", async () => {
    await signIn(page);
    const start = Date.now();
    await page.goto(roomUrl);
    await expect(
      page.getByRole("textbox", { name: "Message Room", exact: true }),
    ).toBeVisible();
    timings.initialReadyMs = Date.now() - start;
    await page
      .getByRole("textbox", { name: "Message Room", exact: true })
      .fill(
        Array.from(
          { length: 45 },
          (_, index) =>
            `${marker} paragraph ${index}: a conversation that remains mounted during background initialization.`,
        ).join("\n\n"),
      );
    const sent = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/v0/rooms/${fixture.room_id}/messages`),
    );
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    expect((await sent).status()).toBe(201);
    const committed = page
      .getByRole("article")
      .filter({ hasText: `${marker} paragraph 44` });
    await expect(committed).toHaveCount(1);
    await expect(committed).toBeVisible();
  });

  for (const resource of ["rooms", "another-me", "voice-media-policy"]) {
    await test.step(`Hold the real ${resource} response and keep typing before release`, async () => {
      let release!: () => void;
      let held = false;
      let completed = false;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pattern = `**/v0/tenants/${fixture.tenant_id}/${resource}*`;
      await page.route(pattern, async (route) => {
        const response = await route.fetch();
        if (resource === "voice-media-policy") {
          expect(await response.json()).toMatchObject({
            voice_media_supported: false,
          });
        }
        held = true;
        await gate;
        await route.fulfill({ response });
        completed = true;
      });
      try {
        const start = Date.now();
        await page.goto(roomUrl);
        const composer = page.getByRole("textbox", {
          name: "Message Room",
          exact: true,
        });
        await expect(composer).toBeVisible({ timeout: 10_000 });
        timings[`${resource}HeldReadyMs`] = Date.now() - start;
        // Auxiliary code can load after chat is ready. Wait for the real
        // response using route.fetch's request budget, not the UI assertion budget.
        await expect
          .poll(() => held, {
            message: `The real ${resource} response reaches the hold gate`,
            timeout: 30_000,
          })
          .toBe(true);
        expect(completed).toBe(false);
        await expect(
          page
            .getByRole("article")
            .filter({ hasText: `${marker} paragraph 44` }),
        ).toBeVisible();
        await composer.fill(draft);
        const composerNode = await composer.elementHandle();
        const timeline = page.getByLabel("Room timeline", { exact: true });
        await expect(timeline).toHaveAttribute(
          "data-initial-scroll-ready",
          "true",
        );
        await timeline.hover();
        await page.mouse.wheel(0, -900);
        await expect
          .poll(() =>
            timeline.evaluate(
              (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
            ),
          )
          .toBeGreaterThan(200);
        await composer.focus();
        const beforeScroll = await timeline.evaluate((node) => node.scrollTop);
        await page.screenshot({
          path: testInfo.outputPath(`${resource}-held.png`),
        });
        release();
        await expect.poll(() => completed).toBe(true);
        // Wait for the actual response's downstream React work, including lazy engines.
        await expect(
          page.getByRole("status").filter({
            hasText: /Loading Rooms|Loading workspace|Loading space/,
          }),
        ).toHaveCount(0);
        await expect(composer).toHaveValue(draft);
        expect(
          await composer.evaluate(
            (node, original) => node === original,
            composerNode,
          ),
        ).toBe(true);
        await expect(composer).toBeFocused();
        await expect
          .poll(() => timeline.evaluate((node) => node.scrollTop))
          .toBe(beforeScroll);
        await page.screenshot({
          path: testInfo.outputPath(`${resource}-released.png`),
        });
      } finally {
        release();
        await page.unrouteAll({ behavior: "wait" });
      }
    });
  }

  await test.step("Send the retained draft and verify TeamHub persisted it", async () => {
    const sent = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/v0/rooms/${fixture.room_id}/messages`),
    );
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    expect((await sent).status()).toBe(201);
    const committed = page.getByRole("article").filter({ hasText: draft });
    // HTTP receipt can precede the React update that removes the local outbox row.
    await expect(committed).toHaveCount(1);
    await expect(committed).toBeVisible();
    const response = await page.request.get(
      `/v0/rooms/${fixture.room_id}/messages?limit=200`,
    );
    expect(response.ok()).toBe(true);
    const data = await response.json();
    expect(
      data.items.some(
        (item: { raw_message: string }) => item.raw_message === draft,
      ),
    ).toBe(true);
  });

  await test.step("Create another Room and compare cold and cached in-app navigation", async () => {
    await page
      .getByRole("navigation", { name: "Room navigation", exact: true })
      .getByRole("button", { name: "Create chat", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Create Room", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Create Room",
      exact: true,
    });
    const name = "Startup second Room";
    await dialog.getByLabel("Room name").fill(name);
    await dialog
      .getByRole("button", { name: "Create Room", exact: true })
      .click();
    const addMembers = page.getByRole("dialog", {
      name: "Add Room members",
      exact: true,
    });
    await addMembers
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await addMembers
      .getByRole("button", { name: "Skip for now", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Message Room", exact: true }),
    ).toBeVisible();
    const secondUrl = new URL(page.url()).pathname;
    await page.goto(roomUrl);
    await expect(
      page.getByRole("textbox", { name: "Message Room", exact: true }),
    ).toBeVisible();
    for (const mode of ["cold", "cached"]) {
      const start = Date.now();
      await page.getByRole("link", { name, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${secondUrl}$`));
      await expect(
        page.getByRole("region", { name: `Room ${name}`, exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: "Message Room", exact: true }),
      ).toBeVisible();
      timings[`${mode}SwitchMs`] = Date.now() - start;
      await page.locator(`a[href="${roomUrl}"]`).first().click();
      await expect(
        page.getByRole("article").filter({ hasText: draft }),
      ).toBeVisible();
    }
  });

  await test.step("Reopen through login in a fresh browser context", async () => {
    const context = await browser.newContext({ baseURL });
    try {
      const fresh = await context.newPage();
      await signIn(fresh);
      await fresh.goto(roomUrl);
      await expect(
        fresh.getByRole("article").filter({ hasText: draft }),
      ).toBeVisible();
      await fresh.screenshot({
        path: testInfo.outputPath("persisted-fresh-session.png"),
      });
    } finally {
      await context.close();
    }
  });
  expect(errors).toEqual([]);
  await writeFile(
    testInfo.outputPath("proof.json"),
    JSON.stringify(
      {
        feature: "room-startup",
        roomUrl,
        timings,
        draftPersisted: true,
        freshContext: true,
        transport:
          "Real TeamHub responses held at browser boundary; no substituted business data",
        notVerified: [
          "Live microphone/Voice Runtime",
          "Agent execution",
          "CI network latency",
        ],
      },
      null,
      2,
    ),
  );
});

test("Room sending releases the next draft and Document opening avoids the credential waterfall", async ({
  page,
  browser,
  request,
  baseURL,
}, info) => {
  test.setTimeout(180_000);
  const harness = new RoomDocumentE2EHarnessClient(request);
  const fixture = await harness.reset();
  const marker = `Responsive send ${Date.now()}`;
  const roomUrl = `/t/${fixture.tenant_id}/rooms/${fixture.room_id}/chat`;
  const documentUrl = `/t/${fixture.tenant_id}/documents/${fixture.document_id}`;
  const proof: Record<string, unknown> = { simulatedBusinessResponses: false };
  if (process.env.VERIFY_LINGER_EVIDENCE) {
    await writeFile(
      info.outputPath("doctor.txt"),
      execFileSync("apps/web/e2e/doctor.sh", {
        encoding: "utf8",
      }),
    );
  }
  let releaseSend = () => {};
  let releaseOpen = () => {};
  try {
    await signIn(page);
    // Prepare a persisted card via the public API; opening/editing below uses the UI.
    const metadataResponse = await page.request.get(
      `/v0/documents/${fixture.document_id}`,
    );
    expect(metadataResponse.ok()).toBe(true);
    const metadata = await metadataResponse.json();
    const cardResponse = await page.request.post(
      `/v0/rooms/${fixture.room_id}/messages`,
      {
        headers: { "Idempotency-Key": `card-${Date.now()}` },
        data: {
          raw_message: metadata.title,
          segments: [
            {
              type: "document",
              document_id: fixture.document_id,
              content: metadata.title,
              presentation: "card",
            },
          ],
        },
      },
    );
    expect(cardResponse.status(), await cardResponse.text()).toBe(201);
    await page.goto(roomUrl);
    await test.step("Queue two messages while the first real HTTP acknowledgement is held", async () => {
      const composer = page.getByRole("textbox", {
        name: "Message Room",
        exact: true,
      });
      let posts = 0;
      let committed = false;
      const gate = new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
      await page.route(
        `**/v0/rooms/${fixture.room_id}/messages`,
        async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          posts++;
          const response = await route.fetch();
          expect(response.status()).toBe(201);
          if (posts === 1) {
            committed = true;
            await gate;
          }
          await route.fulfill({ response });
        },
      );
      await composer.fill(`${marker} first`);
      const started = Date.now();
      await page
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      await expect(composer).toHaveValue("");
      await expect(composer).toBeEditable();
      const acceptanceMs = Date.now() - started;
      await composer.fill(`${marker} second`);
      await page
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      await expect(composer).toHaveValue("");
      await expect(composer).toBeEditable();
      await composer.fill(`${marker} first`); // Identical newer draft must survive the older ACK.
      await expect.poll(() => committed).toBe(true);
      expect(posts).toBe(1);
      await page.screenshot({ path: info.outputPath("sending-held.png") });
      releaseSend();
      await expect.poll(() => posts).toBe(2);
      await expect
        .poll(async () => {
          const response = await page.request.get(
            `/v0/rooms/${fixture.room_id}/messages?limit=200`,
          );
          const body = await response.json();
          return body.items.filter((message: { raw_message: string }) =>
            message.raw_message.startsWith(marker),
          ).length;
        })
        .toBe(2);
      await expect(
        page.getByRole("article").filter({ hasText: `${marker} second` }),
      ).toHaveCount(1);
      await expect(composer).toHaveValue(`${marker} first`);
      proof.send = {
        acceptanceMs,
        posts,
        durableReadback: true,
        newerIdenticalDraftPreserved: true,
      };
      await page.unrouteAll({ behavior: "wait" });
    });
    await test.step("Open the Online document card while loading editor code in parallel", async () => {
      const requests: string[] = [];
      page.on("request", (req) => {
        requests.push(req.url());
      });
      let held = false;
      let openMs = 0;
      let openRequests = 0;
      const gate = new Promise<void>((resolve) => {
        releaseOpen = resolve;
      });
      await page.route(
        `**/v0/documents/${fixture.document_id}/open`,
        async (route) => {
          openRequests++;
          const started = Date.now();
          const response = await route.fetch();
          openMs = Date.now() - started;
          expect(response.status()).toBe(200);
          held = true;
          await gate;
          await route.fulfill({ response });
        },
      );
      await page
        .getByRole("button", { name: `Open ${metadata.title}`, exact: true })
        .click();
      await expect.poll(() => held).toBe(true);
      await expect
        .poll(() =>
          requests.some((url) =>
            /room-document-blocknote-editor(?:\.tsx|-[^/]+\.js)/.test(url),
          ),
        )
        .toBe(true);
      expect(
        requests.filter(
          (url) =>
            new URL(url).pathname === `/v0/documents/${fixture.document_id}`,
        ),
      ).toHaveLength(0);
      expect(
        requests.filter((url) =>
          /\/(collaboration|read-session)-credentials$/.test(url),
        ),
      ).toHaveLength(0);
      expect(openRequests).toBe(1);
      releaseOpen();
      const surface = page.getByLabel("Room Document editor");
      await expect(surface).toBeVisible({ timeout: 30_000 });
      await page
        .getByRole("button", { name: "Document mode", exact: true })
        .click();
      await page.getByRole("menuitem", { name: /\bEdit$/ }).click();
      const editor = surface.locator(".bn-editor");
      await expect(editor).toBeEditable();
      await editor.click();
      await editor.press("ControlOrMeta+End");
      await editor.pressSequentially(marker);
      await expect(
        page.locator("[data-room-document-save-status]"),
      ).toHaveAttribute("data-room-document-save-status", "Saved", {
        timeout: 30_000,
      });
      await expect
        .poll(async () => (await harness.state()).persisted_seq)
        .toBeGreaterThan(0);
      await page.screenshot({ path: info.outputPath("document-saved.png") });
      proof.document = {
        entry: "Online document card",
        openMs,
        openRequests,
        initialMetadataGET: 0,
        separateCredentialPOST: 0,
        editorRequestedBeforeOpenResponse: true,
        saved: true,
      };
      await page.unrouteAll({ behavior: "wait" });
    });
    await test.step("Read messages and edited Document in a fresh authenticated browser context", async () => {
      const context = await browser.newContext({ baseURL });
      try {
        const reopened = await context.newPage();
        await signIn(reopened);
        await reopened.goto(roomUrl);
        await expect(
          reopened.getByRole("article").filter({ hasText: `${marker} first` }),
        ).toHaveCount(1);
        await expect(
          reopened.getByRole("article").filter({ hasText: `${marker} second` }),
        ).toHaveCount(1);
        await reopened.goto(documentUrl);
        await expect(reopened.getByLabel("Room Document editor")).toContainText(
          marker,
          { timeout: 30_000 },
        );
        await reopened.screenshot({
          path: info.outputPath("fresh-readback.png"),
        });
        proof.freshContextReadback = true;
      } finally {
        await context.close();
      }
    });
    await writeFile(
      info.outputPath("proof.json"),
      JSON.stringify(proof, null, 2),
    );
  } finally {
    releaseSend();
    releaseOpen();
    await page.unrouteAll({ behavior: "wait" });
  }
});
