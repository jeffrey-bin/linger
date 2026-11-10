import { expect, test, type Request } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { RoomDocumentE2EHarnessClient } from "./room-document-e2e-harness-client";

const filename = "single-100kb.docx";
const attachmentFilename = "sent-attachment-100kb.docx";
const marker = "Issue 199 single DOCX cold preview";
const unrelated =
  /(?:\/(?:comments|yjs|blocknote[^/]*|FloatingThreadController|mermaid-svg-preview|room-document-(?:blocknote-editor|comment-schema))[-.])/;

interface TimedRequest {
  end?: number;
  method: string;
  path: string;
  start: number;
}

test("ordinary Office entry and direct link load only preview dependencies", async ({
  page,
  browser,
  request,
  baseURL,
}, info) => {
  const harness = new RoomDocumentE2EHarnessClient(request);
  const fixture = await harness.reset();
  try {
    await page.goto("/login");
    await page.getByLabel("Email").fill("alice@example.com");
    await page
      .getByLabel("Password", { exact: true })
      .fill("teamhub-dev-alice");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/t\//);
    const content = await readFile(
      "apps/web/e2e/fixtures/office/single-100kb.docx",
    );
    expect(content.byteLength).toBe(98982);
    const uploaded = await page.request.post(
      `/v0/rooms/${fixture.room_id}/documents/uploads`,
      {
        headers: { "Idempotency-Key": crypto.randomUUID() },
        multipart: {
          filename,
          // Room message attachments store Office files as binary, which is
          // the format whose current Version metadata the card caches.
          representation_format: "binary",
          media_type:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          content: {
            name: filename,
            mimeType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            buffer: content,
          },
        },
      },
    );
    expect(uploaded.status(), await uploaded.text()).toBe(201);
    const document = await uploaded.json();
    const card = await page.request.post(
      `/v0/rooms/${fixture.room_id}/messages`,
      {
        headers: { "Idempotency-Key": crypto.randomUUID() },
        data: {
          raw_message: filename,
          segments: [
            {
              type: "document",
              document_id: document.id,
              content: filename,
              presentation: "card",
            },
          ],
        },
      },
    );
    expect(card.status(), await card.text()).toBe(201);
    // Send a real attachment through the composer; it opens via its own card path.
    await page.goto(`/t/${fixture.tenant_id}/rooms/${fixture.room_id}/chat`);
    const attachmentUpload = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response
          .url()
          .endsWith(`/rooms/${fixture.room_id}/message-attachment-uploads`),
    );
    await page.getByLabel("Choose message attachments").setInputFiles({
      name: attachmentFilename,
      mimeType: "application/octet-stream",
      buffer: content,
    });
    expect((await attachmentUpload).status()).toBe(201);
    const attachmentSent = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/rooms/${fixture.room_id}/messages`),
    );
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    const sent = await attachmentSent;
    expect(sent.status(), await sent.text()).toBe(201);
    const [attachment] = (await sent.json()).attachments;
    const auth = await page.context().storageState();
    for (const entry of ["card", "direct", "version", "attachment"] as const) {
      const entryFilename =
        entry === "attachment" ? attachmentFilename : filename;
      const entryDocumentId =
        entry === "attachment" ? attachment.document_id : document.id;
      const entryVersionId =
        entry === "attachment"
          ? attachment.document_version_id
          : document.current_version.id;
      const context = await browser.newContext({ baseURL, storageState: auth });
      try {
        const urls: string[] = [];
        const errors: string[] = [];
        const timed: TimedRequest[] = [];
        const timedByRequest = new Map<Request, TimedRequest>();
        context.on("request", (req) => {
          const path = new URL(req.url()).pathname;
          urls.push(path);
          const record = {
            method: req.method(),
            path,
            start: performance.now(),
          };
          timed.push(record);
          timedByRequest.set(req, record);
        });
        context.on("requestfinished", (req) => {
          const record = timedByRequest.get(req);
          if (record) record.end = performance.now();
        });
        const reader = await context.newPage();
        let clickedAt = 0;
        reader.on("pageerror", (error) => errors.push(error.message));
        if (entry === "direct") {
          await reader.goto(`/t/${fixture.tenant_id}/documents/${document.id}`);
        } else if (entry === "card" || entry === "attachment") {
          const cardVersion = reader.waitForResponse(
            (response) =>
              new URL(response.url()).pathname ===
              `/v0/document-versions/${entryVersionId}`,
          );
          await reader.goto(
            `/t/${fixture.tenant_id}/rooms/${fixture.room_id}/chat`,
          );
          await cardVersion;
          clickedAt = performance.now();
          await reader
            .getByRole("button", { name: `Open ${entryFilename}`, exact: true })
            .click();
        } else {
          const pinned = await page.request.post(
            `/v0/rooms/${fixture.room_id}/messages`,
            {
              headers: { "Idempotency-Key": crypto.randomUUID() },
              data: {
                raw_message: "Pinned Version",
                segments: [{ type: "text", content: "Pinned Version" }],
                context_document_version_ids: [document.current_version.id],
              },
            },
          );
          expect(pinned.status(), await pinned.text()).toBe(201);
          const cardVersion = reader.waitForResponse(
            (response) =>
              new URL(response.url()).pathname ===
              `/v0/document-versions/${document.current_version.id}`,
          );
          await reader.goto(
            `/t/${fixture.tenant_id}/rooms/${fixture.room_id}/chat`,
          );
          await cardVersion;
          clickedAt = performance.now();
          await reader
            .getByRole("article")
            .filter({ hasText: "Pinned Version" })
            .getByRole("button", { name: `Open ${filename}`, exact: true })
            .click();
        }
        const frame = reader.frameLocator(
          `iframe[title="Basic preview ${entryFilename}"]`,
        );
        await expect(frame.locator("body")).toContainText(marker, {
          timeout: 20000,
        });
        await expect(
          reader.getByText("Preparing basic preview", { exact: true }),
        ).toBeHidden();
        await expect(frame.locator("img")).toBeVisible();
        const scripts = urls.filter((url) => url.endsWith(".js"));
        expect(
          scripts.some((url) => url.includes("office-preview-frame-")),
        ).toBe(true);
        expect(
          scripts.some((url) =>
            url.includes("office-preview-preflight-worker-"),
          ),
        ).toBe(true);
        expect(scripts.filter((url) => unrelated.test(url))).toEqual([]);
        expect(
          urls.filter(
            (url) => url === `/v0/document-versions/${entryVersionId}/content`,
          ),
        ).toHaveLength(1);
        const openPath = `/v0/documents/${entryDocumentId}/open`;
        const versionPath = `/v0/document-versions/${entryVersionId}`;
        const content = timed.find(
          (request) => request.path === `${versionPath}/content`,
        );
        expect(content, "content request must be recorded").toBeDefined();
        const open = timed.find(
          (request) =>
            request.method === "POST" &&
            request.path === openPath &&
            request.start >= clickedAt,
        );
        expect(open, "POST open must be recorded").toBeDefined();
        expect(open!.end, "open must finish").toBeDefined();
        // Open returns the current Version, so no Session or Version lookup precedes content.
        expect(
          timed.filter(
            (request) =>
              request.method === "GET" &&
              (request.path === "/v0/session" ||
                request.path === versionPath) &&
              request.start >= (clickedAt || open!.start) &&
              request.start < content!.start,
          ),
        ).toEqual([]);
        if (entry === "direct") {
          expect(
            content!.start,
            "a direct link learns the Version from open",
          ).toBeGreaterThanOrEqual(open!.end!);
        } else {
          // Room cards start content from immutable card metadata alongside open.
          expect(
            content!.start,
            "card content must not wait for open",
          ).toBeLessThan(open!.end!);
        }
        const relativeMs = (time?: number) =>
          time === undefined
            ? null
            : Math.round(time - (clickedAt || open!.start));
        const timing = Object.fromEntries(
          Object.entries({ content, open }).map(([label, request]) => [
            label,
            {
              startMs: relativeMs(request!.start),
              endMs: relativeMs(request!.end),
            },
          ]),
        );
        expect(errors).toEqual([]);
        await reader.screenshot({ path: info.outputPath(`${entry}.png`) });
        await info.attach(`${entry}-requests.json`, {
          body: JSON.stringify({ urls, timing }, null, 2),
          contentType: "application/json",
        });
        if (entry === "direct") {
          await reader
            .getByRole("button", { name: "More Document actions", exact: true })
            .click();
          await reader
            .getByRole("menuitem", { name: "Page history", exact: true })
            .click();
          await expect(
            reader.getByRole("dialog", { name: /history/i }),
          ).toBeVisible();
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await harness.cleanup();
  }
});
