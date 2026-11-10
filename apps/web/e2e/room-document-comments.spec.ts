import { expect, test } from "@playwright/test";

import {
  enterRoomDocumentEditMode,
  enterRoomDocumentReadMode,
  openRoomDocumentEditor,
} from "./room-document-collaboration-test-support";
import { RoomDocumentE2EHarnessClient } from "./room-document-e2e-harness-client";

test.afterEach(async ({ request }) => {
  await new RoomDocumentE2EHarnessClient(request).cleanup();
});

test("keeps the empty Comments drawer inside a narrow viewport", async ({
  browser,
  request,
}, testInfo) => {
  const harness = new RoomDocumentE2EHarnessClient(request);
  const fixture = await harness.reset();
  const alice = await openRoomDocumentEditor(browser, fixture);

  try {
    await alice.waitForSaveStatus("Saved");
    await alice.page.setViewportSize({ height: 844, width: 390 });
    await alice.surface
      .getByRole("button", { name: "Comments", exact: true })
      .click();
    const comments = alice.surface.getByRole("complementary", {
      name: "All Document comments",
    });
    await expect(comments).toBeVisible();
    await expect(
      comments.getByRole("heading", { name: "Comments" }),
    ).toBeVisible();
    await expect(comments.getByText("No open comments")).toBeVisible();
    const bounds = await comments.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await alice.page.screenshot({
      path: testInfo.outputPath("document-comments-narrow.png"),
    });
  } finally {
    await alice.context.close();
  }
});

test("persists an anchored comment and delivers the Thread to another session over Room SSE", async ({
  browser,
  request,
}) => {
  test.slow();
  const harness = new RoomDocumentE2EHarnessClient(request);
  const fixture = await harness.reset();
  const alice = await openRoomDocumentEditor(browser, fixture);
  const otherSession = await openRoomDocumentEditor(browser, fixture);
  alice.page.setDefaultTimeout(10_000);
  otherSession.page.setDefaultTimeout(10_000);

  try {
    await alice.waitForSaveStatus("Saved");
    await otherSession.waitForSaveStatus("Saved");

    await selectFromStart(alice, "E2E");
    await alice.surface
      .getByRole("button", { exact: true, name: "Add comment" })
      .click();

    const composer = alice.surface.getByLabel("New Document comment");
    await composer.fill("Please check today");
    await composer.press("Enter");
    await expect(composer).not.toBeVisible();
    await expect(alice.surface.getByText("Please check today")).toBeVisible();
    await alice.surface
      .getByRole("button", { name: "Comments", exact: true })
      .click();
    await expect(
      alice.surface.getByText("Please check today"),
    ).not.toBeVisible();
    await alice.editor.locator(".bn-thread-mark").click();
    await expect(
      alice.surface.getByRole("complementary", {
        name: "All Document comments",
      }),
    ).toBeVisible();
    await expect(alice.surface.getByText("Please check today")).toBeVisible();
    await alice.surface
      .getByRole("button", { name: "Comments", exact: true })
      .click();
    await expect(
      alice.surface.getByText("Please check today"),
    ).not.toBeVisible();
    const otherListResult = await otherSession.page.evaluate(
      async (documentId) => {
        const response = await fetch(
          `/v0/documents/${encodeURIComponent(documentId)}/comment-threads?limit=100`,
        );
        return { body: await response.text(), status: response.status };
      },
      fixture.document_id,
    );
    expect(otherListResult.status, otherListResult.body).toBe(200);
    await expect(
      otherSession.surface.getByText("Please check today"),
    ).not.toBeVisible();
    const allComments = otherSession.surface.getByRole("button", {
      name: "Comments",
      exact: true,
    });
    await expect(allComments).toBeVisible();
    await allComments.click();
    await expect(
      otherSession.surface.getByRole("complementary", {
        name: "All Document comments",
      }),
    ).toBeVisible();
    await expect(
      otherSession.surface.getByText("Please check today"),
    ).toBeVisible();
    await allComments.click();
    await expect(
      otherSession.surface.getByRole("complementary", {
        name: "All Document comments",
      }),
    ).not.toBeAttached();
    await allComments.click();
    await alice.waitForSaveStatus("Saved");
    await alice.surface
      .getByRole("button", { name: "Comments", exact: true })
      .click();

    const aliceThread = alice.surface
      .locator(".room-document-comment-thread")
      .filter({ hasText: "Please check today" });
    const commentRow = aliceThread
      .locator(".room-document-comment-row")
      .filter({ hasText: "Please check today" });
    // The reply from the other session is the same Human's, so only the
    // first comment's row scopes the Edit button.
    const editComment = commentRow.getByRole("button", {
      name: "Edit comment",
    });
    await expect(aliceThread).toHaveCount(1);
    await expect(editComment).toHaveCount(1);
    const [commentRowBox, editCommentBox] = await Promise.all([
      commentRow.boundingBox(),
      editComment.boundingBox(),
    ]);
    expect(commentRowBox).not.toBeNull();
    expect(editCommentBox).not.toBeNull();
    expect(editCommentBox!.y).toBeGreaterThanOrEqual(commentRowBox!.y);
    expect(editCommentBox!.y + editCommentBox!.height).toBeLessThanOrEqual(
      commentRowBox!.y + commentRowBox!.height,
    );
    expect(editCommentBox!.x + editCommentBox!.width).toBeLessThanOrEqual(
      commentRowBox!.x + commentRowBox!.width,
    );
    expect(editCommentBox!.x).toBeGreaterThanOrEqual(
      commentRowBox!.x + commentRowBox!.width / 2,
    );

    const aliceSession = new RoomDocumentE2EHarnessClient(
      alice.context.request,
    );
    await expect
      .poll(async () => {
        const threads = await aliceSession.listDocumentCommentThreads(
          fixture.document_id,
        );
        return threads.map((thread) => ({
          anchorStatus: thread.anchor_status,
          segments: thread.comments[0]?.segments,
        }));
      })
      .toEqual([
        {
          anchorStatus: "attached",
          segments: [{ content: "Please check today", type: "text" }],
        },
      ]);

    const otherReply = otherSession.surface.getByLabel(
      "Reply to Document comment",
    );
    await expect(otherReply).toBeVisible();
    await otherReply.fill("Acknowledged from another session");
    await otherReply.press("Enter");
    await expect(
      alice.surface.getByText("Acknowledged from another session"),
    ).toBeVisible();

    await commentRow.hover();
    await expect(editComment).toBeVisible();
    await editComment.click();
    const edit = alice.surface.getByLabel("Edit comment by alice");
    await edit.fill("Updated again");
    await edit.press("Enter");
    await expect(otherSession.surface.getByText("Updated again")).toBeVisible();
  } finally {
    await alice.context.close();
    await otherSession.context.close();
  }
});

test("keeps the document position when focusing selection comments", async ({
  browser,
  request,
}, testInfo) => {
  const fixture = await new RoomDocumentE2EHarnessClient(request).reset();
  const alice = await openRoomDocumentEditor(browser, fixture);
  try {
    await enterRoomDocumentEditMode(alice.surface);
    await alice.editor.click();
    await alice.editor.press("End");
    await alice.page.keyboard.insertText(
      " A long paragraph for focus retention.".repeat(150),
    );
    await alice.editor.press("Enter");
    await alice.page.keyboard.insertText("Comment near the bottom");
    await alice.editor.press("Enter");
    await alice.page.keyboard.insertText(
      " More document content below the comment.".repeat(80),
    );
    await alice.waitForSaveStatus("Saved", { timeout: 30_000 });
    const scroll = alice.page.locator("[data-document-scroll-layout]");
    const panel = alice.surface.getByRole("complementary", {
      name: "All Document comments",
    });
    // Keep the column width stable so this measures focus scrolling, not reflow.
    await alice.surface
      .getByRole("button", { name: "Comments", exact: true })
      .click();
    for (const mode of ["Edit", "Read"] as const) {
      if (mode === "Read") await enterRoomDocumentReadMode(alice.surface);
      const paragraph = alice.editor
        .locator("p")
        .filter({ hasText: "Comment near the bottom" });
      await paragraph.scrollIntoViewIfNeeded();
      await paragraph.evaluate((element) => {
        const container = element.closest<HTMLElement>(
          "[data-document-scroll-layout]",
        )!;
        container.scrollTop +=
          element.getBoundingClientRect().top -
          container.getBoundingClientRect().top -
          120;
      });
      await paragraph.evaluate((element) => {
        element
          .closest<HTMLElement>(".bn-editor")!
          .focus({ preventScroll: true });
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
        element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      });
      const top = await scroll.evaluate((node) => node.scrollTop);
      expect(top).toBeGreaterThan(500);
      await alice.surface
        .getByRole("button", { name: "Add comment", exact: true })
        .click();
      const composer = panel.getByLabel(/^New (Document|selection) comment$/);
      await expect(composer).toBeFocused();
      await expect
        .poll(() => scroll.evaluate((node) => node.scrollTop))
        .toBe(top);
      await composer.fill(`${mode} comment without jumping`);
      await composer.press("Enter");
      const thread = panel
        .locator(".room-document-comment-thread")
        .filter({ hasText: `${mode} comment without jumping` });
      await expect(thread).toBeVisible();
      await alice.waitForSaveStatus("Saved", { timeout: 30_000 });
      await expect
        .poll(() => scroll.evaluate((node) => node.scrollTop))
        .toBe(top);
      await thread.getByLabel("Reply to Document comment").click();
      const reply = thread.getByLabel("Reply to Document comment");
      await expect(reply).toBeFocused();
      await expect
        .poll(() => scroll.evaluate((node) => node.scrollTop))
        .toBe(top);
      await reply.fill(`${mode} reply`);
      await reply.press("Enter");
      await expect(reply).toHaveValue("");
      await expect(
        thread.getByText(`${mode} reply`, { exact: true }),
      ).toBeVisible();
      if (mode === "Edit") {
        const viewport = alice.page.viewportSize()!;
        await alice.page.setViewportSize({ width: 836, height: 418 });
        for (const targetTop of [300, 100]) {
          await expect
            .poll(async () => {
              await reply.evaluate((element, y) => {
                const container = element.closest<HTMLElement>(
                  "[data-document-comments-scroll]",
                )!;
                container.scrollTop += element.getBoundingClientRect().top - y;
              }, targetTop);
              return Math.abs((await reply.boundingBox())!.y - targetTop);
            })
            .toBeLessThan(2);
          await reply.fill("@");
          const menu = thread.locator(".message-mention-menu");
          const area = (await scroll.boundingBox())!;
          await expect
            .poll(async () => (await menu.boundingBox())!.y)
            .toBeGreaterThanOrEqual(area.y);
          await expect
            .poll(async () => {
              const bounds = (await menu.boundingBox())!;
              return bounds.y + bounds.height;
            })
            .toBeLessThanOrEqual(area.y + area.height);
          for (const name of ["all", "people"]) {
            const tab = menu.getByRole("tab", { name, exact: true });
            expect(
              await tab.evaluate((element) => {
                const rect = element.getBoundingClientRect();
                return element.contains(
                  document.elementFromPoint(
                    rect.x + rect.width / 2,
                    rect.y + rect.height / 2,
                  ),
                );
              }),
            ).toBe(true);
          }
          const scrollBefore = await scroll.evaluate((node) => node.scrollTop);
          await reply.press("ArrowDown");
          expect(await scroll.evaluate((node) => node.scrollTop)).toBe(
            scrollBefore,
          );
          await alice.page.screenshot({
            path: testInfo.outputPath(`mention-menu-${targetTop}.png`),
          });
          await reply.fill("");
        }
        await alice.page.setViewportSize(viewport);
        await scroll.evaluate((node, value) => {
          node.scrollTop = value;
        }, top);
      }

      const row = thread.locator(".room-document-comment-row").first();
      await row.hover();
      // Hover may scroll the row into view. Measure editing from that settled
      // position rather than attributing Playwright's reveal to editor focus.
      const beforeEditTop = await scroll.evaluate((node) => node.scrollTop);
      await row.getByRole("button", { name: "Edit comment" }).click();
      await expect(row.getByLabel("Edit comment by alice")).toBeFocused();
      await expect
        .poll(() => scroll.evaluate((node) => node.scrollTop))
        .toBe(beforeEditTop);
      await row.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect
        .poll(() => scroll.evaluate((node) => node.scrollTop))
        .toBe(beforeEditTop);
      await alice.page.screenshot({
        path: testInfo.outputPath(`comment-focus-${mode}.png`),
      });
    }
  } finally {
    await alice.context.close();
  }
});

test("scrolls comments with the document and removes discussions with deleted selections", async ({
  browser,
  request,
}, testInfo) => {
  test.slow();
  const harness = new RoomDocumentE2EHarnessClient(request);
  const fixture = await harness.reset();
  const alice = await openRoomDocumentEditor(browser, fixture);
  const otherSession = await openRoomDocumentEditor(browser, fixture);

  try {
    await alice.waitForSaveStatus("Saved", { timeout: 30_000 });
    await enterRoomDocumentEditMode(alice.surface);
    await alice.editor.click();
    await alice.editor.press("End");
    await alice.page.keyboard.insertText(
      " " +
        "A long document paragraph for linked scrolling. ".repeat(100) +
        "scroll-proof-end",
    );
    await expect(alice.editor).toContainText("scroll-proof-end");
    await alice.waitForSaveStatus("Saved", { timeout: 30_000 });
    await alice.page
      .locator("[data-document-scroll-layout]")
      .evaluate((node) => {
        node.scrollTop = 0;
      });
    await selectFromStart(alice, "E2E");
    await alice.surface
      .getByRole("button", { exact: true, name: "Add comment" })
      .click();
    await alice.surface
      .getByLabel("New Document comment")
      .fill("Keep this reference");
    await alice.surface.getByLabel("New Document comment").press("Enter");
    await alice.waitForSaveStatus("Saved", { timeout: 30_000 });

    const aliceSession = new RoomDocumentE2EHarnessClient(
      alice.context.request,
    );
    await expect
      .poll(
        async () =>
          (
            await aliceSession.listDocumentCommentThreads(fixture.document_id)
          )[0]?.anchor_status,
      )
      .toBe("attached");

    const documentScroll = alice.page.locator("[data-document-scroll-layout]");
    const comments = alice.surface.getByRole("complementary", {
      name: "All Document comments",
    });
    if (!(await comments.isVisible()))
      await alice.surface
        .getByRole("button", { name: "Comments", exact: true })
        .click();
    await comments.getByLabel("Reply to Document comment").click();
    await comments
      .getByLabel("Reply to Document comment")
      .fill("Remove replies too");
    await comments.getByLabel("Reply to Document comment").press("Enter");
    await expect
      .poll(
        async () =>
          (
            await aliceSession.listDocumentCommentThreads(fixture.document_id)
          )[0]?.comments.length,
      )
      .toBe(2);
    await otherSession.surface
      .getByRole("button", { name: "Comments", exact: true })
      .click();
    await expect(
      otherSession.surface.getByText("Remove replies too"),
    ).toBeVisible();
    await alice.page.screenshot({
      path: testInfo.outputPath("linked-scroll.png"),
    });

    const mark = alice.editor.locator(".bn-thread-mark").first();
    const card = comments.locator(".room-document-comment-thread").first();
    const markBefore = (await mark.boundingBox())!;
    const cardBefore = (await card.boundingBox())!;
    await comments.hover();
    await alice.page.mouse.wheel(0, 400);
    await expect
      .poll(() => documentScroll.evaluate((node) => node.scrollTop))
      .toBeGreaterThan(100);
    const markAfter = (await mark.boundingBox())!;
    const cardAfter = (await card.boundingBox())!;
    expect(
      Math.abs(markAfter.y - markBefore.y - (cardAfter.y - cardBefore.y)),
    ).toBeLessThan(5);
    await documentScroll.evaluate((node) => {
      node.scrollTop = 0;
    });

    await enterRoomDocumentEditMode(alice.surface);
    await selectFromStart(alice, "E");
    await alice.page.keyboard.press("Backspace");
    await alice.waitForSaveStatus("Saved", { timeout: 30_000 });
    // TeamHub reconciles the anchor after the save, passing through pending.
    await expect
      .poll(
        async () =>
          (
            await aliceSession.listDocumentCommentThreads(fixture.document_id)
          )[0]?.anchor_status,
      )
      .toBe("attached");
    const beforeDelete = (await harness.state()).persisted_seq;
    await selectFromStart(alice, "2E");
    await alice.page.keyboard.press("Backspace");
    await expect(alice.editor).not.toContainText("E2E");
    await expect
      .poll(async () => (await harness.state()).persisted_seq)
      .toBeGreaterThan(beforeDelete);
    await expect
      .poll(
        async () =>
          (await aliceSession.listDocumentCommentThreads(fixture.document_id))
            .length,
      )
      .toBe(0);

    const allComments = alice.surface.getByRole("button", {
      name: "Comments",
      exact: true,
    });
    const drawer = alice.surface.getByRole("complementary", {
      name: "All Document comments",
    });
    if (!(await drawer.isVisible())) await allComments.click();
    await expect(alice.surface.getByText("Keep this reference")).toHaveCount(0);
    await expect(alice.surface.getByText("Deleted reference")).toHaveCount(0);
    await expect(alice.surface.getByText("Remove replies too")).toHaveCount(0);
    await expect(
      otherSession.surface.getByText("Keep this reference"),
    ).toHaveCount(0);
    await expect(
      otherSession.surface.getByText("Remove replies too"),
    ).toHaveCount(0);
    await alice.page.reload();
    await alice.waitForSaveStatus("Saved", { timeout: 30_000 });
    await alice.surface
      .getByRole("button", { name: "Comments", exact: true })
      .click();
    await expect(alice.surface.getByText("Keep this reference")).toHaveCount(0);
    await expect(alice.surface.getByText("No open comments")).toBeVisible();
    await alice.page.screenshot({
      path: testInfo.outputPath("deleted-and-reopened.png"),
    });

    await expect(
      alice.surface.getByRole("button", { name: "Re-anchor comment" }),
    ).not.toBeAttached();
  } finally {
    await alice.context.close();
    await otherSession.context.close();
  }
});

test("orders new comments by editing location and keeps authors clear of actions", async ({
  browser,
  request,
}, testInfo) => {
  test.slow();
  const harness = new RoomDocumentE2EHarnessClient(request);
  const fixture = await harness.reset();
  const alice = await openRoomDocumentEditor(browser, fixture);
  try {
    await enterRoomDocumentEditMode(alice.surface);
    await selectFromStart(alice, "E2E initial state");
    await alice.page.keyboard.type("First paragraph");
    await alice.page.keyboard.press("Enter");
    await alice.page.keyboard.type("Middle paragraph");
    await alice.page.keyboard.press("Enter");
    await alice.page.keyboard.type("Final paragraph");
    await alice.waitForSaveStatus("Saved", { timeout: 30_000 });
    await expect(alice.editor.locator("p")).toHaveText([
      "First paragraph",
      "Middle paragraph",
      "Final paragraph",
    ]);
    const panel = alice.surface.getByRole("complementary", {
      name: "All Document comments",
    });
    async function beginComment(text: string) {
      if (await panel.isVisible())
        await panel.getByRole("button", { name: "Close comments" }).click();
      await alice.editor
        .locator("p")
        .filter({ hasText: text })
        .evaluate((element) => {
          const root = element.closest<HTMLElement>(".bn-editor")!;
          root.focus();
          const range = document.createRange();
          range.selectNodeContents(element);
          const selection = window.getSelection()!;
          selection.removeAllRanges();
          selection.addRange(range);
          document.dispatchEvent(
            new Event("selectionchange", { bubbles: true }),
          );
        });
      await expect
        .poll(() =>
          alice.page.evaluate(() => window.getSelection()?.toString()),
        )
        .toBe(text);
      await alice.surface
        .getByRole("button", { name: "Add comment", exact: true })
        .click();
      await expect(panel.getByLabel("New Document comment")).toBeVisible();
    }
    async function sendComment(body: string) {
      await panel.getByLabel("New Document comment").fill(body);
      const draft = panel.locator(".room-document-pending-comment");
      const draftTop = (await draft.boundingBox())!.y;
      await panel.getByLabel("New Document comment").press("Enter");
      const posted = panel
        .locator(".room-document-comment-thread")
        .filter({ hasText: body });
      await expect(posted).toBeVisible();
      // The lane re-aligns when the draft becomes a taller posted card, which
      // can settle the pane a pixel or two away. A real regression moves the
      // card by a card height, not by two pixels.
      await expect
        .poll(async () => Math.abs((await posted.boundingBox())!.y - draftTop))
        .toBeLessThanOrEqual(2);
      await alice.waitForSaveStatus("Saved", { timeout: 30_000 });
    }
    await beginComment("Final paragraph");
    await sendComment("Last discussion");
    const stableReply = panel.getByLabel("Reply to Document comment");
    const beforeInput = (await stableReply.boundingBox())!;
    await stableReply.fill("@");
    for (const name of ["all", "people"]) {
      const tab = panel.getByRole("tab", { name, exact: true });
      await expect(tab).toBeVisible();
      expect(
        await tab.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return element.contains(
            document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
            ),
          );
        }),
      ).toBe(true);
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
    }
    const duringInput = (await stableReply.boundingBox())!;
    expect(duringInput.x).toBe(beforeInput.x);
    expect(duringInput.width).toBe(beforeInput.width);
    await stableReply.fill("Stable reply");
    await stableReply.press("Enter");
    await expect(stableReply).toHaveValue("");
    await expect(
      panel.getByText("Stable reply", { exact: true }),
    ).toBeVisible();
    const afterInput = (await stableReply.boundingBox())!;
    expect(afterInput.x).toBe(beforeInput.x);
    expect(afterInput.width).toBe(beforeInput.width);

    await beginComment("First paragraph");
    await sendComment("First discussion");
    await beginComment("Middle paragraph");
    const entries = panel.locator(".bn-threads-sidebar > *");
    await expect(entries).toHaveCount(3);
    await expect(entries.nth(0)).toContainText("First discussion");
    await expect(entries.nth(1)).toContainText("Middle paragrap");
    await expect(entries.nth(2)).toContainText("Last discussion");
    await sendComment("Middle discussion");
    await expect(entries.nth(0)).toContainText("First discussion");
    await expect(entries.nth(1)).toContainText("Middle discussion");
    await expect(entries.nth(2)).toContainText("Last discussion");
    await expect(
      panel.locator(".room-document-comment-meta strong"),
    ).toHaveText(["alice", "alice", "alice", "alice"]);
    await expect(
      panel.getByRole("button", { name: "Resolve comment", exact: true }),
    ).toHaveCount(0);
    for (const width of [1440, 390]) {
      await alice.page.setViewportSize({ width, height: 900 });
      const row = panel.locator(".room-document-comment-row").first();
      await row.hover();
      const name = await row.locator("strong").boundingBox();
      const actions = await row
        .locator(".room-document-comment-actions")
        .boundingBox();
      expect(actions!.y).toBeLessThan(name!.y + name!.height);
      expect(actions!.x).toBeGreaterThan(name!.x + name!.width);
      await expect(row.getByRole("button", { name: /reaction/ })).toHaveCount(
        0,
      );
      if (width === 390) {
        await expect(
          alice.page.locator(".bn-formatting-toolbar"),
        ).not.toBeVisible();
      }
      const replyBox = panel.locator(".message-composer-box").first();
      const send = replyBox.getByRole("button", { name: "Send message" });
      const inputBounds = (await replyBox.boundingBox())!;
      const sendBounds = (await send.boundingBox())!;
      expect(sendBounds.x).toBeGreaterThanOrEqual(inputBounds.x);
      expect(sendBounds.x + sendBounds.width).toBeLessThanOrEqual(
        inputBounds.x + inputBounds.width,
      );
      expect(sendBounds.y).toBeGreaterThanOrEqual(inputBounds.y);
      expect(sendBounds.y + sendBounds.height).toBeLessThanOrEqual(
        inputBounds.y + inputBounds.height,
      );
      const bounds = await panel.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      await alice.page.screenshot({
        path: testInfo.outputPath(`comment-location-${width}.png`),
      });
    }
    const session = new RoomDocumentE2EHarnessClient(alice.context.request);
    await expect
      .poll(
        async () =>
          (await session.listDocumentCommentThreads(fixture.document_id))
            .length,
      )
      .toBe(3);
  } finally {
    await alice.context.close();
  }
});

type OpenDocumentEditor = Awaited<ReturnType<typeof openRoomDocumentEditor>>;

async function selectFromStart(editor: OpenDocumentEditor, expected: string) {
  await selectEditorText(editor, expected, "start");
}

async function selectEditorText(
  editor: OpenDocumentEditor,
  expected: string,
  edge: "start" | "end",
) {
  const selected = await editor.editor.evaluate(
    (root, options) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      let current = walker.nextNode();
      while (current) {
        if (current.textContent?.length) {
          nodes.push(current as Text);
        }
        current = walker.nextNode();
      }
      const totalLength = nodes.reduce(
        (total, node) => total + (node.textContent?.length ?? 0),
        0,
      );
      const startOffset =
        options.edge === "start" ? 0 : totalLength - options.length;
      const endOffset = startOffset + options.length;

      const boundaryAt = (absoluteOffset: number) => {
        let consumed = 0;
        for (const node of nodes) {
          const length = node.textContent?.length ?? 0;
          if (absoluteOffset <= consumed + length) {
            return { node, offset: absoluteOffset - consumed };
          }
          consumed += length;
        }
        throw new Error("Selection offset is outside the Room Document text");
      };

      const start = boundaryAt(startOffset);
      const end = boundaryAt(endOffset);
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      const selection = window.getSelection();
      if (!selection) {
        throw new Error("Selection API is unavailable");
      }
      (root as HTMLElement).focus();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      return selection.toString();
    },
    { edge, length: expected.length },
  );
  expect(selected).toBe(expected);
  await expect
    .poll(() => editor.page.evaluate(() => window.getSelection()?.toString()))
    .toBe(expected);
  await editor.page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
}

test("aligns dense comments independently at document edges and highlights the current card", async ({
  browser,
  request,
}, testInfo) => {
  test.slow();
  const fixture = await new RoomDocumentE2EHarnessClient(request).reset();
  const alice = await openRoomDocumentEditor(browser, fixture);
  try {
    await alice.page.setViewportSize({ width: 1440, height: 1000 });
    await enterRoomDocumentEditMode(alice.surface);
    await selectFromStart(alice, "E2E initial state");
    for (let index = 0; index < 7; index += 1) {
      if (index) await alice.page.keyboard.press("Enter");
      await alice.page.keyboard.insertText(`Dense reference ${index}`);
    }
    await alice.waitForSaveStatus("Saved", { timeout: 30_000 });
    await alice.surface
      .getByRole("button", { name: "Comments", exact: true })
      .click();
    const panel = alice.surface.getByRole("complementary", {
      name: "All Document comments",
    });
    const docScroll = alice.page.locator("[data-document-scroll-layout]");
    const commentScroll = panel.locator("[data-document-comments-scroll]");
    for (const index of [5, 0, 4, 1, 3, 2, 6]) {
      const paragraph = alice.editor
        .locator("p")
        .filter({ hasText: `Dense reference ${index}` });
      await paragraph.evaluate((element) => {
        element
          .closest<HTMLElement>(".bn-editor")!
          .focus({ preventScroll: true });
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
        element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      });
      await alice.surface
        .getByRole("button", { name: "Add comment", exact: true })
        .click();
      const input = panel.getByLabel("New Document comment");
      await input.fill(`Dense discussion ${index}`);
      const draft = panel.locator(".room-document-pending-comment");
      await expect(draft).toHaveAttribute("data-comment-active", "true");
      await expect
        .poll(async () =>
          Math.abs(
            (await draft.boundingBox())!.y - (await paragraph.boundingBox())!.y,
          ),
        )
        .toBeLessThan(8);
      const draftTop = (await draft.boundingBox())!.y;
      await input.press("Enter");
      const posted = panel
        .locator(".room-document-comment-thread")
        .filter({ hasText: `Dense discussion ${index}` });
      await expect(posted).toBeVisible();
      // The lane re-aligns when the draft becomes a taller posted card, which
      // can settle the pane a pixel or two away. A real regression moves the
      // card by a card height, not by two pixels.
      await expect
        .poll(async () => Math.abs((await posted.boundingBox())!.y - draftTop))
        .toBeLessThanOrEqual(2);
      await alice.waitForSaveStatus("Saved", { timeout: 30_000 });
    }
    await expect(docScroll).toHaveJSProperty("scrollTop", 0);
    const cards = panel.locator("[data-comment-card]");
    for (let index = 0; index < 7; index += 1)
      await expect(cards.nth(index)).toContainText(`Dense discussion ${index}`);
    await expect
      .poll(() => commentScroll.evaluate((node) => node.scrollTop))
      .toBeGreaterThan(300);
    // The active marker is an inset edge on the card itself, so it follows the
    // rounded border instead of overlaying it.
    const active = panel.locator('[data-comment-active="true"]');
    expect(
      await active.evaluate((node) => getComputedStyle(node).boxShadow),
    ).toContain("rgb(231, 176, 8)");
    await alice.page.screenshot({
      path: testInfo.outputPath("dense-aligned.png"),
    });

    // Both positive and negative wheel deltas still reach comments when the
    // outer document scrollbar is the shared visible scroll surface.
    const before = await commentScroll.evaluate((node) => node.scrollTop);
    const documentBefore = await docScroll.evaluate((node) => node.scrollTop);
    await docScroll.hover();
    await alice.page.mouse.wheel(0, -250);
    await expect
      .poll(() => commentScroll.evaluate((node) => node.scrollTop))
      .toBeLessThan(before - 200);
    await expect
      .poll(() => docScroll.evaluate((node) => node.scrollTop))
      .toBeLessThanOrEqual(documentBefore);
    await alice.page.mouse.wheel(0, 180);
    await expect
      .poll(() => commentScroll.evaluate((node) => node.scrollTop))
      .toBeGreaterThan(before - 100);
    await expect
      .poll(() => docScroll.evaluate((node) => node.scrollTop))
      .toBeGreaterThanOrEqual(documentBefore);
    // Selecting a different highlighted range reveals its card and aligns it.
    for (const index of [0, 6, 6]) {
      await commentScroll.evaluate((node) => {
        node.scrollTop = 0;
      });
      const mark = alice.editor
        .locator(".bn-thread-mark")
        .filter({ hasText: `Dense reference ${index}` })
        .first();
      await mark.click();
      const card = cards.nth(index);
      await expect(card).toHaveAttribute("data-comment-active", "true");
      await expect
        .poll(async () =>
          Math.abs(
            (await card.boundingBox())!.y - (await mark.boundingBox())!.y,
          ),
        )
        .toBeLessThan(8);
      await expect
        .poll(async () => {
          const panelBounds = await panel.boundingBox();
          const cardBounds = await card.boundingBox();
          if (!panelBounds || !cardBounds) return false;
          return (
            cardBounds.y >= panelBounds.y &&
            cardBounds.y + cardBounds.height <=
              panelBounds.y + panelBounds.height
          );
        })
        .toBe(true);
    }
    await alice.page.screenshot({
      path: testInfo.outputPath("dense-reselected.png"),
    });
    expect(
      (
        await new RoomDocumentE2EHarnessClient(
          alice.context.request,
        ).listDocumentCommentThreads(fixture.document_id)
      ).length,
    ).toBe(7);
  } finally {
    await alice.context.close();
  }
});
