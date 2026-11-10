import { expect, test } from "@playwright/test";

import {
  enterRoomDocumentEditMode,
  openRoomDocumentEditor,
} from "./room-document-collaboration-test-support";
import { RoomDocumentE2EHarnessClient } from "./room-document-e2e-harness-client";

const frontmatter = `---
type: Process
title: Multichannel outreach
description: Lev8 outreach abstracts platform-specific sending behind adapters, with Agent and Inbox entry points sharing sequence queues, delivery state, and future scheduling and follow-up extensions.
resource: [https://example.com/wiki/frontmatter-resource](https://example.com/wiki/frontmatter-resource)
tags: [lev8, outreach, sequence, adapters, messaging]
graph:
  schema_version: 1
  id: multichannel-outreach
  topic_kind: process
  representation: knowledge
  summary: Platform-independent outreach process using adapter routing and ordered queues.
generated: { by: "openwiki/0.4.3", at: "2026-09-15T10:35:43.842Z" }
---`;

test.afterEach(async ({ request }) => {
  await new RoomDocumentE2EHarnessClient(request).cleanup();
});

test("recovers external media left in an offline draft by an old client", async ({
  browser,
  request,
}) => {
  const fixture = await new RoomDocumentE2EHarnessClient(request).reset();
  const alice = await openRoomDocumentEditor(browser, fixture);
  try {
    await enterRoomDocumentEditMode(alice.surface);
    await alice.editor.click();
    await alice.editor.press("ControlOrMeta+End");
    await alice.editor.press("Enter");
    // Native clipboard setup recreates the Yjs state that older Web clients
    // produced from external HTML, without changing the durable service data.
    await alice.editor.evaluate((element) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData(
        "blocknote/html",
        '<div data-node-type="blockGroup"><div data-node-type="blockContainer" data-id="legacy-text"><p>Legacy unsaved text</p></div><div data-node-type="blockContainer" data-id="legacy-image"><div data-content-type="image" data-url="https://example.test/legacy.png" data-caption="Legacy image"><img src="https://example.test/legacy.png"></div></div></div>',
      );
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }),
      );
    });
    await expect(alice.editor).toContainText("Legacy unsaved text");
    await alice.waitForSaveStatus("Offline pending", { timeout: 15_000 });
    await alice.page.reload();
    await expect(alice.editor).toContainText("E2E initial state");
    await enterRoomDocumentEditMode(alice.surface);
    await alice.waitForSaveStatus("Saved", { timeout: 15_000 });
    await expect(alice.editor).toContainText("Legacy unsaved text");
    await expect(
      alice.editor.locator('a[href="https://example.test/legacy.png"]'),
    ).toBeVisible();
    const reopened = await openRoomDocumentEditor(browser, fixture);
    try {
      await expect(reopened.editor).toContainText("Legacy unsaved text");
      await expect(
        reopened.editor.locator('a[href="https://example.test/legacy.png"]'),
      ).toBeVisible();
    } finally {
      await reopened.context.close();
    }
  } finally {
    await alice.context.close();
  }
});

test("saves a large rich paste and then renames the Document", async ({
  browser,
  request,
}, testInfo) => {
  const fixture = await new RoomDocumentE2EHarnessClient(request).reset();
  const alice = await openRoomDocumentEditor(browser, fixture);
  try {
    await enterRoomDocumentEditMode(alice.surface);
    await alice.editor.click();
    await alice.editor.press("ControlOrMeta+End");
    await alice.editor.press("Enter");
    const html =
      "<h1>Summary</h1><blockquote>Meeting notes</blockquote>" +
      Array.from(
        { length: 100 },
        (_, index) =>
          `<ul><li><strong>Target user ${index}</strong><ul><li>This is pasted meeting notes covering user positioning and product needs.</li></ul></li></ul>`,
      ).join("") +
      '<p>End of pasted content</p><img src="https://example.test/meeting.png" alt="Meeting flowchart">';
    await alice.context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await alice.page.evaluate(async (content) => {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([content], { type: "text/html" }),
          "text/plain": new Blob(["Summary\nMeeting notes"], {
            type: "text/plain",
          }),
        }),
      ]);
    }, html);
    await alice.editor.press("ControlOrMeta+v");
    await expect(alice.editor).toContainText("End of pasted content");
    await alice.waitForSaveStatus("Saved", { timeout: 15_000 });
    await alice.surface.getByTitle("Rename document").click();
    const title = alice.surface.getByLabel("Document title");
    await title.fill("Saved meeting notes");
    await title.press("Enter");
    await alice.waitForSaveStatus("Saved", { timeout: 15_000 });
    await expect(
      alice.surface.getByRole("heading", { name: "Saved meeting notes" }),
    ).toBeVisible();
    const reopened = await openRoomDocumentEditor(browser, fixture);
    try {
      await expect(reopened.editor).toContainText("Target user 99");
      await expect(reopened.editor).toContainText("End of pasted content");
      await expect(
        reopened.surface.getByRole("heading", { name: "Saved meeting notes" }),
      ).toBeVisible();
      await reopened.page.screenshot({
        path: testInfo.outputPath("rich-paste-reopened.png"),
      });
    } finally {
      await reopened.context.close();
    }
  } finally {
    await alice.context.close();
  }
});

for (const escaped of [false, true])
  test(`recognizes ${escaped ? "escaped" : "plain"} frontmatter and selects the entire document`, async ({
    browser,
    request,
  }, testInfo) => {
    const fixture = await new RoomDocumentE2EHarnessClient(request).reset();
    const alice = await openRoomDocumentEditor(browser, fixture);
    try {
      await enterRoomDocumentEditMode(alice.surface);
      await alice.editor.click();
      await alice.editor.press("ControlOrMeta+Home");
      await alice.editor.press("Enter");
      await alice.editor.press("ArrowUp");
      await alice.context.grantPermissions([
        "clipboard-read",
        "clipboard-write",
      ]);
      const source = escaped
        ? frontmatter
            .replace(/^---$/gm, "\\---")
            .replace(/_/g, "\\_")
            .replace(/^ {2}/gm, "\u00a0 ")
        : frontmatter;
      await alice.page.evaluate(
        (text) => navigator.clipboard.writeText(text),
        source + "\n\n# Document body\n\nBody after metadata.",
      );
      await alice.editor.press("ControlOrMeta+v");
      await alice.waitForSaveStatus("Saved", { timeout: 30_000 });
      const code = alice.editor.locator(
        '.bn-block > [data-content-type="codeBlock"]',
      );
      await expect(code).toHaveAttribute("data-language", "yaml");
      await expect(code.locator("code")).toHaveText(source);
      for (const key of ["Meta+a", "Control+a"]) {
        await code.locator("code").click();
        await alice.page.keyboard.press(key);
        const selected = await alice.page.evaluate(() =>
          window.getSelection()?.toString(),
        );
        expect(selected).toContain("type: Process");
        expect(selected).toContain("Body after metadata.");
        expect(selected).toContain("E2E initial state");
        await testInfo.attach(`selected-${key}`, {
          body: selected ?? "",
          contentType: "text/plain",
        });
      }
      await alice.page.screenshot({
        path: testInfo.outputPath("selection.png"),
      });
      // Keep independent user edits outside the collaborative undo capture window.
      await alice.page.waitForTimeout(600);
      await alice.page.keyboard.type("Replaced entire document");
      await expect(alice.editor).toHaveText("Replaced entire document");
      await alice.page.keyboard.press("ControlOrMeta+z");
      await expect(code.locator("code")).toHaveText(source);
      await alice.waitForSaveStatus("Saved", { timeout: 30_000 });
      await alice.page.waitForTimeout(600);
      await alice.page.keyboard.press("ControlOrMeta+a");
      await alice.page.evaluate(
        (text) => navigator.clipboard.writeText(text),
        source + "\n\nReplacement body.",
      );
      await alice.page.keyboard.press("ControlOrMeta+v");
      await expect(code).toHaveCount(1);
      await expect(code.locator("code")).toHaveText(source);
      await expect(alice.editor).toContainText("Replacement body.");
      await expect(alice.editor).not.toContainText("E2E initial state");
      await alice.page.keyboard.press("ControlOrMeta+z");
      await expect(alice.editor).toContainText("E2E initial state");
      await alice.waitForSaveStatus("Saved", { timeout: 30_000 });
      await alice.page.reload();
      await expect(
        alice.page
          .getByLabel("Room Document editor")
          .locator('.bn-block > [data-content-type="codeBlock"] code'),
      ).toHaveText(source);
    } finally {
      await alice.context.close();
    }
  });
