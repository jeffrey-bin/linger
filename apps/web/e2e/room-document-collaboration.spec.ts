import { stat } from "node:fs/promises";

import { expect, test, type Locator } from "@playwright/test";

import {
  appendRoomDocumentText,
  enterRoomDocumentEditMode,
  enterRoomDocumentReadMode,
  openRoomDocumentEditor,
  openRoomDocumentEditorInContext,
  waitForRoomDocumentSessionOpened,
} from "./room-document-collaboration-test-support";
import { RoomDocumentE2EHarnessClient } from "./room-document-e2e-harness-client";

test.afterEach(async ({ request }) => {
  await new RoomDocumentE2EHarnessClient(request).cleanup();
});

test("keeps a native Document readable across desktop viewports", async ({
  browser,
  request,
}, testInfo) => {
  const harness = new RoomDocumentE2EHarnessClient(request);
  const fixture = await harness.reset();
  const opened = await openRoomDocumentEditor(browser, fixture);

  try {
    await opened.waitForSaveStatus("Saved");
    await appendRoomDocumentText(
      opened.editor,
      " Native document width verification",
      opened.surface,
    );
    await opened.waitForSaveStatus("Saved");
    const editor = opened.page.getByLabel("Room Document editor", {
      exact: true,
    });
    for (const width of [1440, 2560, 3440]) {
      await opened.page.setViewportSize({ width, height: 1080 });
      const bounds = (await editor.boundingBox())!;
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.width).toBeGreaterThan(600);
      expect(bounds.width).toBeLessThanOrEqual(720);
      const layout = await editor
        .locator("xpath=ancestor::*[contains(@class, 'room-document-layout')]")
        .boundingBox();
      expect(layout).not.toBeNull();
      expect(bounds.x + bounds.width / 2).toBeCloseTo(
        layout!.x + layout!.width / 2,
        0,
      );
      await opened.page.screenshot({
        path: testInfo.outputPath(`native-document-${width}.png`),
      });
    }
    await opened.editor.click();
    await opened.editor.press("End");
    await opened.page.keyboard.insertText(
      ` ${"A long native Document must scroll inside its sidebar. ".repeat(400)}`,
    );
    await opened.waitForSaveStatus("Saved");
    await opened.page.goto(
      `/t/${fixture.tenant_id}/rooms/${fixture.room_id}/chat`,
    );
    await opened.page
      .getByRole("button", { name: "Show sidebar", exact: true })
      .click();
    const panel = opened.page.getByRole("complementary", {
      name: "Panel sidebar",
    });
    await panel.getByRole("button", { name: "Documents", exact: true }).click();
    const documents = panel
      .getByRole("navigation", { name: "Room files" })
      .locator("button.workspace-file-name");
    await expect(documents).toHaveCount(1);
    await documents.click();
    // The document layout owns the scrollbar now; the inner column stretches to
    // its content instead of scrolling on its own.
    const scroll = panel.locator(
      `[data-testid="panel-tab-file-${fixture.document_id}"] [data-document-scroll-layout]`,
    );
    await expect(panel.getByLabel("Room Document editor")).toBeVisible();
    await expect
      .poll(() =>
        scroll.evaluate(
          (element) => element.scrollHeight - element.clientHeight,
        ),
      )
      .toBeGreaterThan(1000);
    await scroll.hover();
    await opened.page.mouse.wheel(0, 600);
    await expect
      .poll(() => scroll.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await panel
      .getByRole("button", { name: "Maximize sidebar", exact: true })
      .click();
    await expect(panel).toHaveAttribute("data-maximized", "true");
    await expect(panel.getByLabel("Room Document editor")).toBeVisible();
    await panel
      .getByRole("button", { name: "Restore sidebar", exact: true })
      .click();
    await expect
      .poll(() => scroll.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
  } finally {
    await opened.context.close();
  }
});

test("renames the Document from its title and keeps the body editable", async ({
  browser,
  request,
}) => {
  const harness = new RoomDocumentE2EHarnessClient(request);
  const fixture = await harness.reset();
  const opened = await openRoomDocumentEditor(browser, fixture);
  try {
    await opened.waitForSaveStatus("Saved");
    await enterRoomDocumentEditMode(opened.surface);
    await opened.surface.getByTitle("Rename document").click();
    const title = opened.surface.getByLabel("Document title");
    await title.fill("Durable title command");
    await title.press("Enter");

    // The title lives on the Document row, not in the body, so the editor
    // never waits on the rename.
    await expect(
      opened.surface.getByRole("heading", { name: "Durable title command" }),
    ).toBeVisible();
    await expect(
      opened.surface.getByLabel("Room Document editor"),
    ).toHaveAttribute("data-editable", "true");
    await expect(opened.editor).toBeFocused();
    await expect
      .poll(() =>
        opened.editor.evaluate((root) => {
          const selection = window.getSelection();
          return (
            selection !== null &&
            root.contains(selection.anchorNode) &&
            selection.anchorOffset === 0
          );
        }),
      )
      .toBe(true);
    await appendRoomDocumentText(opened.editor, " after title", opened.surface);
    await opened.waitForSaveStatus("Saved");
    await expect(opened.visibleStatus).toHaveText("Saved");
    await opened.page.reload();
    await expect(
      opened.surface.getByRole("heading", { name: "Durable title command" }),
    ).toBeVisible();
  } finally {
    await opened.context.close();
  }
});

test("undoes only local edits with the standard keyboard shortcut and persists the result", async ({
  browser,
  request,
}) => {
  const harness = new RoomDocumentE2EHarnessClient(request);
  const fixture = await harness.reset();
  const alice = await openRoomDocumentEditor(browser, fixture);
  const otherSession = await openRoomDocumentEditor(browser, fixture);
  let aliceClosed = false;
  let otherSessionClosed = false;
  let reopened: Awaited<ReturnType<typeof openRoomDocumentEditor>> | undefined;

  try {
    await alice.waitForSaveStatus("Saved");
    await otherSession.waitForSaveStatus("Saved");
    const initialPersistedSeq = (await harness.state()).persisted_seq;

    await appendRoomDocumentText(
      otherSession.editor,
      " remote",
      otherSession.surface,
    );
    await expect(alice.editor).toContainText("E2E initial state remote");
    await expect
      .poll(async () => (await harness.state()).persisted_seq)
      .toBeGreaterThan(initialPersistedSeq);
    const remotePersistedSeq = (await harness.state()).persisted_seq;

    await appendRoomDocumentText(alice.editor, " local", alice.surface);
    await expect(otherSession.editor).toContainText(
      "E2E initial state remote local",
    );

    await alice.editor.press(
      process.platform === "darwin" ? "Meta+z" : "Control+z",
    );

    await expect(alice.editor).toContainText("E2E initial state remote");
    await expect(alice.editor).not.toContainText("local");
    await expect(otherSession.editor).toContainText("E2E initial state remote");
    await expect(otherSession.editor).not.toContainText("local");
    await expect
      .poll(async () => (await harness.state()).persisted_seq)
      .toBeGreaterThan(remotePersistedSeq);
    await alice.waitForSaveStatus("Saved");
    await otherSession.waitForSaveStatus("Saved");

    await alice.context.close();
    aliceClosed = true;
    await otherSession.context.close();
    otherSessionClosed = true;
    reopened = await openRoomDocumentEditor(browser, fixture);
    await expect(reopened.editor).toContainText("E2E initial state remote");
    await expect(reopened.editor).not.toContainText("local");
  } finally {
    if (!aliceClosed) await alice.context.close();
    if (!otherSessionClosed) await otherSession.context.close();
    await reopened?.context.close();
  }
});

test("renders the Room Document formatting toolbar as a compact floating control", async ({
  browser,
  request,
}) => {
  const harness = new RoomDocumentE2EHarnessClient(request);
  const fixture = await harness.reset();
  const opened = await openRoomDocumentEditor(browser, fixture);

  try {
    await appendRoomDocumentText(opened.editor, " formatted", opened.surface);
    await expect(opened.editor).toHaveCSS("outline-style", "none");
    await opened.editor.selectText();
    const formattingToolbar = opened.page.locator(".bn-formatting-toolbar");
    await expect(formattingToolbar).toBeVisible();
    await expect(formattingToolbar).toHaveCSS("display", "flex");
    const toolbarBounds = await formattingToolbar.boundingBox();
    expect(toolbarBounds?.height).toBeLessThan(64);
  } finally {
    await opened.context.close();
  }
});

test("moves two Chromium clients from local pending to durable saved", async ({
  browser,
  request,
}) => {
  const harness = new RoomDocumentE2EHarnessClient(request);
  const fixture = await harness.reset();
  const first = await openRoomDocumentEditor(browser, fixture);
  const second = await openRoomDocumentEditor(browser, fixture);

  try {
    await first.waitForSaveStatus("Saved");
    await second.waitForSaveStatus("Saved");
    await expect
      .poll(async () => (await harness.state()).session_open_success_count)
      .toBeGreaterThanOrEqual(2);
    await harness.holdAppends();

    await appendRoomDocumentText(first.editor, " shared", first.surface);
    await first.waitForSaveStatus("Local pending");
    await expect(second.editor).toContainText("E2E initial state shared");
    await harness.releaseAppends();
    await first.waitForSaveStatus("Saved");
    await second.waitForSaveStatus("Saved");
  } finally {
    await first.context.close();
    await second.context.close();
  }
});

test("persists and reopens an editable Mermaid diagram for another collaborator", async ({
  browser,
  request,
}) => {
  const harness = new RoomDocumentE2EHarnessClient(request);
  const fixture = await harness.reset();
  const first = await openRoomDocumentEditor(browser, fixture);
  let second: Awaited<ReturnType<typeof openRoomDocumentEditor>> | undefined;

  try {
    await first.waitForSaveStatus("Saved");
    await enterRoomDocumentEditMode(first.surface);
    await first.editor.click();
    await first.editor.press("End");
    await first.editor.press("Enter");
    await first.editor.pressSequentially("/mermaid", { delay: 20 });
    await first.page.getByRole("option", { name: "Mermaid diagram" }).click();
    const sourceSurface = first.editor.locator(
      ".room-document-mermaid__source",
    );
    const source = sourceSurface.locator("code");
    await sourceSurface.click();
    await first.page.keyboard.insertText("graph TD");
    await first.page.keyboard.press("Enter");
    await first.page.keyboard.insertText("  Human --> Agent");
    await expect(source).toContainText("Human --> Agent");
    await first.editor.getByRole("button", { name: "Preview" }).click();
    const firstPreview = first.editor.frameLocator(
      'iframe[title="Mermaid diagram preview"]',
    );
    await expect(firstPreview.locator("svg")).toBeVisible({ timeout: 15_000 });
    await expect(firstPreview.locator("body")).toContainText("Human");
    await first.waitForSaveStatus("Saved");

    second = await openRoomDocumentEditor(browser, fixture);
    await enterRoomDocumentReadMode(second.surface);
    const secondPreview = second.editor.frameLocator(
      'iframe[title="Mermaid diagram preview"]',
    );
    await expect(secondPreview.locator("svg")).toBeVisible({ timeout: 15_000 });
    await expect(secondPreview.locator("body")).toContainText("Agent");
    await expect(
      second.editor.locator(".room-document-mermaid__source"),
    ).toBeHidden();
    await expect(
      second.editor.getByRole("button", { name: "Source", exact: true }),
    ).toHaveCount(0);
    await enterRoomDocumentEditMode(second.surface);
    await second.editor
      .getByRole("button", { name: "Source", exact: true })
      .click();
    const secondSource = second.editor.locator(
      ".room-document-mermaid__source code",
    );
    await expect(secondSource).toBeVisible();
    await expect(secondSource).toContainText("Human --> Agent");
  } finally {
    await first.context.close();
    await second?.context.close();
  }
});

test("rehydrates offline IndexedDB state and resumes after a Runtime restart", async ({
  browser,
  request,
}) => {
  const harness = new RoomDocumentE2EHarnessClient(request);
  const fixture = await harness.reset();
  const context = await browser.newContext();
  let opened = await openRoomDocumentEditorInContext(context, fixture);

  try {
    await opened.waitForSaveStatus("Saved");
    await context.setOffline(true);
    await appendRoomDocumentText(opened.editor, " offline", opened.surface);
    await expect(opened.visibleStatus).toHaveText("Offline changes pending");
    await opened.page.close();
    await context.setOffline(false);
    opened = await openRoomDocumentEditorInContext(context, fixture);
    await expect(opened.editor).toContainText("E2E initial state offline");
    await opened.waitForSaveStatus("Saved");

    const sessionOpensBeforeRestart = (await harness.state())
      .session_open_success_count;
    await harness.stopRuntime();
    await expect(opened.visibleStatus).toHaveText("Offline");
    await harness.startRuntime();
    // Saved can reappear as soon as the websocket reconnects because
    // #remoteHydrated is sticky. Wait for a completed TeamHub
    // session open before placing the caret.
    await waitForRoomDocumentSessionOpened(harness, sessionOpensBeforeRestart);
    await opened.waitForSaveStatus("Saved", { timeout: 10_000 });
    await appendRoomDocumentText(opened.editor, " restarted", opened.surface);
    await expect(opened.editor).toContainText(
      "E2E initial state offline restarted",
    );
    await opened.waitForSaveStatus("Saved");
  } finally {
    await context.close();
  }
});

test("downloads the complete local Yjs state after a permanent save failure", async ({
  browser,
  request,
}) => {
  const harness = new RoomDocumentE2EHarnessClient(request);
  const fixture = await harness.reset();
  const opened = await openRoomDocumentEditor(browser, fixture);

  try {
    await opened.waitForSaveStatus("Saved");
    await harness.failNextAppendPermanently();
    await appendRoomDocumentText(opened.editor, " recovery", opened.surface);
    await expect(opened.visibleStatus).toHaveText("Save protocol error");
    await expect(opened.editor).toHaveAttribute("contenteditable", "false");

    const downloadPromise = opened.page.waitForEvent("download");
    await opened.surface
      .getByRole("button", { name: "Download recovery copy" })
      .click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.recovery\.yjs$/);
    const path = await download.path();
    expect(path).not.toBeNull();
    expect((await stat(path)).size).toBeGreaterThan(0);
  } finally {
    await opened.context.close();
  }
});

test("scrolls the slash menu to its last command without moving the document", async ({
  browser,
  request,
}) => {
  const harness = new RoomDocumentE2EHarnessClient(request);
  const fixture = await harness.reset();
  const opened = await openRoomDocumentEditor(browser, fixture);
  const { page, editor } = opened;
  try {
    await page.setViewportSize({ width: 1280, height: 720 });
    await enterRoomDocumentEditMode(opened.surface);
    await editor.click();
    await editor.press("ControlOrMeta+End");
    await editor.press("Enter");
    for (let i = 0; i < 24; i++) {
      await editor.pressSequentially(`Paragraph ${i}`);
      await editor.press("Enter");
    }
    await editor.pressSequentially("/");
    const menu = page.getByRole("listbox");
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(720);
    const viewport = page.locator(".workspace-content-viewport");
    const documentScrollTop = await viewport.evaluate((el) => el.scrollTop);
    await menu.hover();
    for (let i = 0; i < 15; i++) {
      const previous = await menu.evaluate((el) => el.scrollTop);
      await page.mouse.wheel(0, 100);
      // The wheel has moved the menu, or the menu has no further to scroll.
      await expect
        .poll(() =>
          menu.evaluate(
            (el, previous) =>
              el.scrollTop !== previous ||
              el.scrollTop >= el.scrollHeight - el.clientHeight,
            previous,
          ),
        )
        .toBe(true);
      expect(await menu.evaluate((el) => el.scrollTop)).toBeGreaterThanOrEqual(
        previous,
      );
    }
    await expect
      .poll(() => menu.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await expect(
      page.getByRole("option", { name: "Mermaid diagram", exact: false }),
    ).toBeInViewport();
    await page.mouse.wheel(0, 1000);
    await waitForScrollSettled(menu, viewport);
    expect(await viewport.evaluate((el) => el.scrollTop)).toBe(
      documentScrollTop,
    );
  } finally {
    await opened.context.close();
  }
});

test("keeps bullet and numbered list commands inside table cells", async ({
  browser,
  request,
}, testInfo) => {
  const harness = new RoomDocumentE2EHarnessClient(request);
  const fixture = await harness.reset();
  const opened = await openRoomDocumentEditor(browser, fixture);
  const { page, editor } = opened;
  try {
    await page.setViewportSize({ width: 1280, height: 720 });
    await enterRoomDocumentEditMode(opened.surface);
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/table");
    await page.getByRole("option", { name: /^Table\b/ }).click();
    const cells = editor.locator("td");
    for (const [index, command, first, second] of [
      [0, "/bullet", "• Alpha", "• Beta"],
      [1, "/numbered", "1. Alpha", "2. Beta"],
    ] as const) {
      const cell = cells.nth(index);
      await opened.waitForSaveStatus("Saved");
      if (index === 0) await cell.locator("p").first().click();
      else await page.keyboard.press("Tab");
      await page.keyboard.type(command);
      await page
        .getByRole("option", {
          name: index === 0 ? /^Bullet List\b/ : /^Numbered List\b/,
        })
        .click();
      await page.keyboard.type("Alpha");
      await expect(cell).toContainText(first);
      await page.keyboard.press("Enter");
      await page.keyboard.type("Beta");
      await expect(cell).toContainText(second);
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      await page.keyboard.type("Plain text");
      await expect(cell).toContainText("Plain text");
    }
    await expect(
      editor.locator(
        '[data-content-type="bulletListItem"], [data-content-type="numberedListItem"]',
      ),
    ).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("table-cell-lists.png"),
    });
    await opened.waitForSaveStatus("Saved");
    await page.reload();
    await expect(cells.nth(0)).toContainText("• Beta");
    await expect(cells.nth(1)).toContainText("2. Beta");
  } finally {
    await opened.context.close();
  }
});

test("aligns the empty Heading 1 placeholder with its text caret", async ({
  browser,
  request,
}, testInfo) => {
  const harness = new RoomDocumentE2EHarnessClient(request);
  const fixture = await harness.reset();
  const opened = await openRoomDocumentEditor(browser, fixture);
  const { page, editor } = opened;
  try {
    await page.setViewportSize({ width: 1280, height: 720 });
    await enterRoomDocumentEditMode(opened.surface);
    await editor.click();
    await editor.press("ControlOrMeta+End");
    await editor.press("Enter");
    await editor.pressSequentially("/heading 1");
    await page.getByRole("option", { name: /^Heading 1\b/ }).click();
    const heading = editor.locator("h1");
    await expect(heading).toHaveCSS("font-size", "26px");
    await heading.evaluate(async (element) => {
      await Promise.all(
        element
          .parentElement!.getAnimations({ subtree: true })
          .map((animation) => animation.finished),
      );
    });
    await page.screenshot({
      path: testInfo.outputPath("heading-1-placeholder.png"),
    });
    const typography = await heading.evaluate((element) => {
      const text = getComputedStyle(element);
      const placeholder = getComputedStyle(element.parentElement!, "::after");
      return {
        textSize: text.fontSize,
        placeholderSize: placeholder.fontSize,
        textHeight: text.lineHeight,
        placeholderHeight: placeholder.lineHeight,
      };
    });
    expect(typography.placeholderSize).toBe(typography.textSize);
    expect(typography.placeholderHeight).toBe(typography.textHeight);
    const emptyHeight = (await heading.boundingBox())!.height;
    await editor.pressSequentially("Heading title");
    await expect(heading).toHaveText("Heading title");
    expect((await heading.boundingBox())!.height).toBeCloseTo(emptyHeight, 0);
  } finally {
    await opened.context.close();
  }
});

// Smooth wheel scrolling is done once every watched element reports the same
// scrollTop on two consecutive samples.
async function waitForScrollSettled(...elements: Locator[]) {
  let last = "";
  await expect
    .poll(async () => {
      const current = (
        await Promise.all(
          elements.map((element) => element.evaluate((el) => el.scrollTop)),
        )
      ).join(",");
      const settled = current === last;
      last = current;
      return settled;
    })
    .toBe(true);
}
