import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  authenticateRoomDocumentContext,
  blockExternalFonts,
  enterRoomDocumentEditMode,
  openRoomDocumentEditor,
} from "./room-document-collaboration-test-support";
import { RoomDocumentE2EHarnessClient } from "./room-document-e2e-harness-client";

const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test.afterEach(async ({ request }) => {
  await new RoomDocumentE2EHarnessClient(request).cleanup();
});

test("shares a native Document read-only with an anonymous reader and revokes the link", async ({
  browser,
  request,
}, testInfo) => {
  const fixture = await new RoomDocumentE2EHarnessClient(request).reset();
  const alice = await openRoomDocumentEditor(browser, fixture);
  const guest = await browser.newContext();
  try {
    await alice.page
      .getByRole("button", { name: "Share", exact: true })
      .click();
    const dialog = alice.page.getByRole("dialog", { name: "Share Document" });
    const policyPath = `/v0/documents/${fixture.document_id}/link-share`;
    const created = alice.page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().endsWith(policyPath),
    );
    await dialog.getByRole("combobox", { name: "Link access" }).click();
    await alice.page
      .getByRole("option", { name: "Can edit", exact: true })
      .click();
    const response = await created;
    expect(response.ok()).toBe(true);
    const policy = await response.json();
    expect(policy.url).toMatch(/\/shared-documents#doc_link_/);

    const viewer = await guest.newPage();
    await blockExternalFonts(viewer);
    const sockets: string[] = [];
    viewer.on("websocket", (socket) => sockets.push(socket.url()));
    const contentResponse = viewer.waitForResponse(
      (value) =>
        value.request().method() === "POST" &&
        value.url().endsWith("/v0/shared-documents/content"),
    );
    await viewer.goto(policy.url);
    const content = await contentResponse;
    expect(content.status()).toBe(200);
    expect(content.headers()["x-document-read-only"]).toBe("true");
    expect(content.headers()["content-type"]).toContain("text/markdown");
    await expect(viewer.locator("pre")).toContainText("E2E initial state");
    await expect(viewer.getByText("Read only", { exact: true })).toBeVisible();
    await expect(viewer.getByRole("textbox")).toHaveCount(0);
    await expect(
      viewer.getByRole("button", { name: "Save", exact: true }),
    ).toHaveCount(0);
    expect(sockets).toEqual([]);
    await viewer.screenshot({
      path: testInfo.outputPath("anonymous-native-read.png"),
      fullPage: true,
    });

    const revoked = alice.page.waitForResponse(
      (value) =>
        value.request().method() === "DELETE" &&
        value.url().endsWith(policyPath),
    );
    await dialog.getByRole("combobox", { name: "Link access" }).click();
    await alice.page
      .getByRole("option", { name: "Disabled", exact: true })
      .click();
    expect((await revoked).ok()).toBe(true);
    await viewer.reload();
    await expect(viewer.getByRole("alert")).toContainText("unavailable");
    await expect(viewer.locator("pre")).toHaveCount(0);
    const denied = await guest.request.post(
      new URL("/v0/shared-documents/content", policy.url).href,
      {
        data: { token: new URL(policy.url).hash.slice(1) },
      },
    );
    expect(denied.status()).toBe(404);
    expect(await denied.text()).not.toContain("E2E initial state");
    await viewer.screenshot({
      path: testInfo.outputPath("anonymous-native-revoked.png"),
      fullPage: true,
    });
    await testInfo.attach("anonymous-native-proof.json", {
      body: JSON.stringify({
        documentId: fixture.document_id,
        nativeReadOnly: true,
        collaborationSockets: sockets.length,
        revokedStatus: denied.status(),
      }),
      contentType: "application/json",
    });
  } finally {
    await guest.close();
    await alice.context.close();
  }
});

test("restores horizontal reading position when a wide text preview reopens", async ({
  page,
  request,
}, testInfo) => {
  const fixture = await new RoomDocumentE2EHarnessClient(request).reset();
  await signInPreviewReader(page);
  const name = "wide-lines.txt";
  const document = await uploadPreviewFile(
    page,
    fixture.room_id,
    name,
    "text/plain",
    Buffer.from(
      Array.from(
        { length: 120 },
        (_, index) => `${index} ${"wide column ".repeat(100)}`,
      ).join("\n"),
    ),
  );
  const documentUrl = `/t/${fixture.tenant_id}/documents/${document.id}`;
  const fileLink = page
    .getByLabel("My pages documents", { exact: true })
    .locator(`a[href="${documentUrl}"]`);
  await page.goto(`/t/${fixture.tenant_id}/library`);
  await fileLink.click();
  await expect(page).toHaveURL(documentUrl);
  const pre = page.locator('[data-content-renderer="text"]');
  const code = pre.locator("code");
  await expect(pre).toBeVisible();
  const initialX = (await code.boundingBox())!.x;
  await pre.hover({ position: { x: 200, y: 100 } });
  await page.mouse.wheel(640, 0);
  await expect
    .poll(async () => (await code.boundingBox())!.x)
    .toBeLessThan(initialX - 400);
  const beforeX = (await code.boundingBox())!.x;
  await page.screenshot({ path: testInfo.outputPath("horizontal-before.png") });
  // Reading positions survive in-app navigation in the tab's preview cache.
  await page
    .getByRole("complementary", { name: "Library sidebar" })
    .getByRole("link", { name: "Back to Library", exact: true })
    .click();
  await expect(page).toHaveURL(`/t/${fixture.tenant_id}/library`);
  await fileLink.click();
  await expect(page).toHaveURL(documentUrl);
  await expect(pre).toBeVisible();
  // Measure the visible text, independent of which ancestor owns scrolling.
  await expect
    .poll(async () => (await code.boundingBox())!.x)
    .toBeCloseTo(beforeX, 0);
  await page.screenshot({
    path: testInfo.outputPath("horizontal-reopened.png"),
  });
  await testInfo.attach("horizontal-position.json", {
    body: JSON.stringify({
      initialX,
      beforeX,
      reopenedX: (await code.boundingBox())!.x,
    }),
    contentType: "application/json",
  });
});

test("restores Markdown reading position after a relative image loads late", async ({
  page,
  request,
}, testInfo) => {
  const fixture = await new RoomDocumentE2EHarnessClient(request).reset();
  await signInPreviewReader(page);
  await uploadPreviewFile(
    page,
    fixture.room_id,
    "tall.png",
    "image/png",
    await readFile("apps/web/e2e/fixtures/previews/tall.png"),
  );
  const document = await uploadPreviewFile(
    page,
    fixture.room_id,
    "delayed.md",
    "text/markdown",
    Buffer.from(
      "# Image reading position\n\n![Tall diagram](./tall.png)\n\nEnd of document.",
    ),
  );
  const documentUrl = `/t/${fixture.tenant_id}/documents/${document.id}`;
  const fileLink = page
    .getByLabel("My pages documents", { exact: true })
    .locator(`a[href="${documentUrl}"]`);
  await page.goto(`/t/${fixture.tenant_id}/library`);
  await fileLink.click();
  await expect(page).toHaveURL(documentUrl);
  const article = page.getByRole("article", {
    name: "Read-only Markdown document",
  });
  const image = article.getByRole("img", { name: "Tall diagram" });
  const viewport = article.locator("..");
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalHeight))
    .toBe(2400);
  await article.hover({ position: { x: 200, y: 150 } });
  await page.mouse.wheel(0, 720);
  await expect
    .poll(() => viewport.evaluate((host) => host.scrollTop))
    .toBe(720);
  await page.screenshot({ path: testInfo.outputPath("markdown-before.png") });
  await page
    .getByRole("complementary", { name: "Library sidebar" })
    .getByRole("link", { name: "Back to Library", exact: true })
    .click();
  await expect(page).toHaveURL(`/t/${fixture.tenant_id}/library`);

  let release!: () => void;
  let imageRequested!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    imageRequested = resolve;
  });
  await page.route("**/v0/document-previews/**/tall.png", async (route) => {
    imageRequested();
    await pending;
    await route.continue();
  });
  try {
    await fileLink.click();
    await expect(page).toHaveURL(documentUrl);
    await expect(article).toBeVisible();
    await requested;
    expect(
      await image.evaluate((img: HTMLImageElement) => img.naturalHeight),
    ).toBe(0);
    expect(await viewport.evaluate((host) => host.scrollTop)).toBe(0);
  } finally {
    release();
  }
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalHeight))
    .toBe(2400);
  await expect
    .poll(() => viewport.evaluate((host) => host.scrollTop))
    .toBe(720);
  await page.screenshot({ path: testInfo.outputPath("markdown-reopened.png") });
  await testInfo.attach("markdown-position.json", {
    body: JSON.stringify({
      before: 720,
      whileLoading: 0,
      reopened: await viewport.evaluate((host) => host.scrollTop),
    }),
    contentType: "application/json",
  });
});

async function signInPreviewReader(page: Page) {
  await blockExternalFonts(page);
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email").fill("alice@example.com");
  await page.getByLabel("Password", { exact: true }).fill("teamhub-dev-alice");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/t\//);
}

async function uploadPreviewFile(
  page: Page,
  roomId: string,
  name: string,
  mimeType: string,
  buffer: Buffer,
) {
  const response = await page.request.post(
    `/v0/rooms/${roomId}/documents/uploads`,
    {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      multipart: {
        filename: name,
        media_type: mimeType,
        representation_format: "plain_text",
        content: { name, mimeType, buffer },
      },
    },
  );
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as { id: string };
}

test("uploads one TeamHub Asset and renders it for another collaborator", async ({
  browser,
  request,
}) => {
  const harness = new RoomDocumentE2EHarnessClient(request);
  const fixture = await harness.reset();
  const first = await openRoomDocumentEditor(browser, fixture);
  let second: Awaited<ReturnType<typeof openRoomDocumentEditor>> | undefined;

  try {
    await first.waitForSaveStatus("Saved");
    const beforeUpload = (await harness.state()).persisted_seq;
    await enterRoomDocumentEditMode(first.surface);
    await first.editor.click();
    await first.editor.press("End");
    await first.editor.press("Enter");
    await first.editor.pressSequentially("/image", { delay: 20 });
    await first.page.getByRole("option", { name: /^Image/ }).click();
    await first.surface.locator('input[type="file"]').setInputFiles({
      buffer: pixel,
      mimeType: "image/png",
      name: "pixel.png",
    });

    const firstImage = first.editor.locator('img[alt="pixel.png"]');
    await expect(firstImage).toBeVisible();
    await first.waitForSaveStatus("Saved");
    await expect
      .poll(async () => (await harness.state()).persisted_seq)
      .toBeGreaterThan(beforeUpload);

    second = await openRoomDocumentEditor(browser, fixture);
    const secondImage = second.editor.locator('img[alt="pixel.png"]');
    await expect(secondImage).toBeVisible();
    await expect
      .poll(() =>
        secondImage.evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(1);
    await second.waitForSaveStatus("Saved");
  } finally {
    await first.context.close();
    await second?.context.close();
  }
});

test("keeps audio and video Assets after a second upload and collaborator reopen", async ({
  browser,
  request,
}) => {
  const harness = new RoomDocumentE2EHarnessClient(request);
  const fixture = await harness.reset();
  const first = await openRoomDocumentEditor(browser, fixture);
  let second: Awaited<ReturnType<typeof openRoomDocumentEditor>> | undefined;

  try {
    await first.waitForSaveStatus("Saved");
    const beforeAudio = (await harness.state()).persisted_seq;
    await enterRoomDocumentEditMode(first.surface);
    await insertMediaAsset(first.editor, first.surface, {
      filename: "sample.mp3",
      mediaType: "audio/mpeg",
      slashCommand: "/audio",
      slashOption: "Audio",
    });
    await expect(first.editor.locator('audio[src^="blob:"]')).toBeAttached();
    await first.waitForSaveStatus("Saved");
    await expect
      .poll(async () => (await harness.state()).persisted_seq)
      .toBeGreaterThan(beforeAudio);

    await insertMediaAsset(first.editor, first.surface, {
      filename: "sample.mp4",
      mediaType: "video/mp4",
      slashCommand: "/video",
      slashOption: "Video",
    });
    await expect(first.editor.locator('audio[src^="blob:"]')).toBeAttached();
    await expect(first.editor.locator('video[src^="blob:"]')).toBeAttached();
    await first.waitForSaveStatus("Saved");

    second = await openRoomDocumentEditor(browser, fixture);
    const audio = second.editor.locator('audio[src^="blob:"]');
    const video = second.editor.locator('video[src^="blob:"]');
    await expect(audio).toBeAttached();
    await expect(video).toBeAttached();
    await expectMediaMetadata(audio);
    await expectMediaMetadata(video);
    await second.waitForSaveStatus("Saved");
  } finally {
    await first.context.close();
    await second?.context.close();
  }
});

async function insertMediaAsset(
  editor: Locator,
  surface: Locator,
  fixture: {
    filename: string;
    mediaType: string;
    slashCommand: string;
    slashOption: string;
  },
) {
  await editor.click();
  await editor.press("End");
  await editor.press("Enter");
  await editor.pressSequentially(fixture.slashCommand, { delay: 20 });
  await editor
    .page()
    .getByRole("option", { name: fixture.slashOption })
    .click();
  await surface.locator('input[type="file"]').setInputFiles({
    buffer: await readFile(
      path.join(
        process.cwd(),
        "apps/web/e2e/fixtures/previews",
        fixture.filename,
      ),
    ),
    mimeType: fixture.mediaType,
    name: fixture.filename,
  });
}

async function expectMediaMetadata(media: Locator) {
  await expect
    .poll(() =>
      media.evaluate((element: HTMLMediaElement) => ({
        duration: element.duration,
        error: element.error?.code ?? 0,
        readyState: element.readyState,
      })),
    )
    .toMatchObject({ error: 0, readyState: expect.any(Number) });
  expect(
    await media.evaluate(
      (element: HTMLMediaElement) =>
        element.readyState >= HTMLMediaElement.HAVE_METADATA &&
        Number.isFinite(element.duration) &&
        element.duration > 0,
    ),
  ).toBe(true);
}

for (const kind of ["html", "markdown"] as const) {
  test(`previews ${kind} folder resources and refreshes an expired session`, async ({
    context,
    page,
    request,
  }, testInfo) => {
    const harness = new RoomDocumentE2EHarnessClient(request);
    const fixture = await harness.reset();
    await authenticateRoomDocumentContext(context);
    await blockExternalFonts(page);
    const teamHubUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_ROOM_DOCUMENT_TEAMHUB_PORT ?? "8089"}`;
    const folderResponse = await context.request.post(
      `${teamHubUrl}/v0/tenants/${fixture.tenant_id}/me/document-folders`,
      {
        data: { name: `preview-${kind}` },
        headers: { "Idempotency-Key": `preview-folder-${kind}` },
      },
    );
    expect(folderResponse.status()).toBe(201);
    const folder = await folderResponse.json();
    const upload = async (
      filename: string,
      mediaType: string,
      buffer: Buffer,
    ) => {
      const response = await context.request.post(
        `${teamHubUrl}/v0/tenants/${fixture.tenant_id}/documents/uploads`,
        {
          headers: { "Idempotency-Key": `preview-${kind}-${filename}` },
          multipart: {
            parent_id: folder.id,
            filename,
            representation_format: "plain_text",
            media_type: mediaType,
            content: { name: filename, mimeType: mediaType, buffer },
          },
        },
      );
      expect(response.status(), await response.text()).toBe(201);
      return response.json();
    };
    await upload("logo.png", "image/png", pixel);
    const filename = kind === "html" ? "index.html" : "readme.md";
    const entry = await upload(
      filename,
      kind === "html" ? "application/octet-stream" : "text/markdown",
      Buffer.from(
        kind === "html"
          ? '<h1 id="ready">Waiting</h1><input aria-label="Draft note"><img alt="Logo" src="./logo.png" width="80" height="80"><script>document.getElementById("ready").textContent="HTML preview ready"</script>'
          : "# Markdown preview\n\n![Logo](./logo.png)",
      ),
    );
    const sessionResponse = () =>
      page.waitForResponse(
        (response) =>
          response
            .url()
            .endsWith(
              `/document-versions/${entry.current_version.id}/preview-sessions`,
            ) && response.request().method() === "POST",
      );
    await page.clock.install();
    const firstResponse = sessionResponse();
    await page.goto(`/t/${fixture.tenant_id}/documents/${entry.id}`);
    await firstResponse;
    const image =
      kind === "html"
        ? page
            .frameLocator(`iframe[title="Preview ${filename}"]`)
            .getByRole("img", { name: "Logo" })
        : page.getByRole("img", { name: "Logo" });
    await expect(image).toBeVisible();
    await expect
      .poll(() =>
        image.evaluate((element: HTMLImageElement) => element.naturalWidth),
      )
      .toBe(1);
    if (kind === "html") {
      await expect(
        page
          .frameLocator(`iframe[title="Preview ${filename}"]`)
          .getByRole("heading", { name: "HTML preview ready" }),
      ).toBeVisible();
    }
    if (kind === "html") {
      await page
        .frameLocator(`iframe[title="Preview ${filename}"]`)
        .getByRole("textbox", { name: "Draft note" })
        .fill("Keep this until I refresh");
    }
    await page.clock.fastForward(601000);
    await expect(
      page.getByRole("button", { name: "Refresh preview" }),
    ).toBeVisible();
    if (kind === "html") {
      await expect(
        page
          .frameLocator(`iframe[title="Preview ${filename}"]`)
          .getByRole("textbox", { name: "Draft note" }),
      ).toHaveValue("Keep this until I refresh");
    }
    await page.screenshot({ path: testInfo.outputPath(`${kind}-expired.png`) });
    // Only the browser clock was advanced; align it with the real server before renewal.
    await page.clock.setSystemTime(new Date());
    const nextResponse = sessionResponse();
    await page.getByRole("button", { name: "Refresh preview" }).click();
    await nextResponse;
    await expect(
      page.getByRole("button", { name: "Refresh preview" }),
    ).toHaveCount(0);
    await expect(image).toBeVisible();
    await expect
      .poll(() =>
        image.evaluate((element: HTMLImageElement) => element.naturalWidth),
      )
      .toBe(1);
    await page.screenshot({
      path: testInfo.outputPath(`${kind}-refreshed.png`),
    });
  });
}

for (const [extension, mediaType] of [
  [
    "docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [
    "pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
] as const) {
  test(`persists Office MIME and replays the same ${extension} Chat upload`, async ({
    page,
    request,
  }) => {
    const fixture = await new RoomDocumentE2EHarnessClient(request).reset();
    await blockExternalFonts(page);
    await signInPreviewReader(page);
    await page.goto(`/t/${fixture.tenant_id}/rooms/${fixture.room_id}/chat`);
    const name = `delivery.${extension.toUpperCase()}`;
    const content = await readFile(
      path.join(import.meta.dirname, "fixtures/office", `sample.${extension}`),
    );
    const uploaded = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response
          .url()
          .endsWith(`/rooms/${fixture.room_id}/message-attachment-uploads`),
    );
    await page.getByLabel("Choose message attachments").setInputFiles({
      buffer: content,
      mimeType: "application/octet-stream",
      name,
    });
    const response = await uploaded;
    expect(response.status(), await response.text()).toBe(201);
    const pending = await response.json();
    expect(pending).toMatchObject({ filename: name, media_type: mediaType });
    const original = response.request();
    const headers = await original.allHeaders();
    const replay = await page.request.post(original.url(), {
      headers: {
        "Content-Type": headers["content-type"]!,
        "Idempotency-Key": headers["idempotency-key"]!,
      },
      data: original.postDataBuffer()!,
    });
    expect(replay.status(), await replay.text()).toBe(201);
    expect(await replay.json()).toEqual(pending);
    const sent = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "POST" &&
        candidate.url().endsWith(`/rooms/${fixture.room_id}/messages`),
    );
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    const sentResponse = await sent;
    expect(sentResponse.status(), await sentResponse.text()).toBe(201);
    const message = await sentResponse.json();
    expect(message.attachments).toHaveLength(1);
    const attachment = message.attachments[0];
    await expect(
      page.getByRole("button", { name: `Preview ${name}`, exact: true }),
    ).toBeVisible();
    const version = await page.request.get(
      `/v0/document-versions/${attachment.document_version_id}`,
    );
    expect(version.status(), await version.text()).toBe(200);
    expect(await version.json()).toMatchObject({
      document_id: attachment.document_id,
      media_type: mediaType,
      filename: name,
      size_bytes: content.length,
    });
    const downloaded = await page.request.get(
      `/v0/document-versions/${attachment.document_version_id}/content`,
    );
    expect(downloaded.status()).toBe(200);
    expect(downloaded.headers()["content-type"]).toContain(mediaType);
    expect(await downloaded.body()).toEqual(content);
  });
}
