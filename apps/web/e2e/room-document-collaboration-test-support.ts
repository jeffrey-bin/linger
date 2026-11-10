import {
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";

import { type RoomDocumentE2EFixture } from "./room-document-e2e-harness-client";

const liveWebUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_ROOM_DOCUMENT_WEB_PORT ?? "3008"}`;
const teamHubUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_ROOM_DOCUMENT_TEAMHUB_PORT ?? "8089"}`;
const externalFontUrl = /^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//;

export async function blockExternalFonts(page: Pick<Page, "route">) {
  await page.route(externalFontUrl, (route) => route.abort("blockedbyclient"));
}

// Every browser context signs in as the deployment's only Human, so two
// contexts are two sessions of the same Account.
export async function openRoomDocumentEditor(
  browser: Browser,
  fixture: RoomDocumentE2EFixture,
) {
  const context = await browser.newContext();
  return openRoomDocumentEditorInContext(context, fixture);
}

export async function openRoomChat(
  browser: Browser,
  fixture: RoomDocumentE2EFixture,
) {
  const context = await browser.newContext();
  try {
    await authenticateRoomDocumentContext(context);
    const page = await context.newPage();
    await blockExternalFonts(page);
    await page.goto(
      `${liveWebUrl}/t/${fixture.tenant_id}/rooms/${fixture.room_id}/chat`,
      { waitUntil: "domcontentloaded" },
    );
    await expect(
      page.getByRole("textbox", { name: "Message Room", exact: true }),
    ).toBeVisible();
    return { context, page };
  } catch (error) {
    await context.close();
    throw error;
  }
}

export async function openRoomDocumentEditorInContext(
  context: BrowserContext,
  fixture: RoomDocumentE2EFixture,
) {
  await authenticateRoomDocumentContext(context);
  const page = await context.newPage();
  const documentUrl = `${liveWebUrl}/t/${fixture.tenant_id}/documents/${fixture.document_id}`;
  const editorSurface = page.getByLabel("Room Document editor");
  await openDocumentPage(page, documentUrl, editorSurface);
  await expect(page).toHaveURL(documentUrl);
  await expect(editorSurface).toHaveAttribute("data-editable", /true|false/, {
    timeout: 30_000,
  });
  const surface = page.locator("main").last();
  const editor = editorSurface.locator(".bn-editor");
  const saveStatus = surface.locator("[data-room-document-save-status]");
  // Read the seed only after remote hydration; an editor that is still empty
  // would otherwise type a second seed into the shared Document.
  await expect(saveStatus).toHaveAttribute(
    "data-room-document-save-status",
    "Saved",
    { timeout: 30_000 },
  );
  if (!((await editor.textContent()) ?? "").includes("E2E initial state")) {
    await enterRoomDocumentEditMode(surface);
    await editor.click();
    await page.keyboard.insertText("E2E initial state");
    await expect(editor).toContainText("E2E initial state");
    await expect(saveStatus).toHaveAttribute(
      "data-room-document-save-status",
      "Saved",
      { timeout: 30_000 },
    );
    await surface
      .getByRole("button", { name: "Document mode", exact: true })
      .click();
    await surface
      .page()
      .getByRole("menuitem", { name: "Read", exact: true })
      .click();
    await expect(editorSurface).toHaveAttribute("data-editable", "false");
  }
  await expect(editor).toContainText("E2E initial state", { timeout: 30_000 });
  return {
    context,
    editor,
    page,
    surface,
    visibleStatus: surface.getByRole("status", {
      name: "Document save status",
    }),
    waitForSaveStatus: (expected: string, options?: { timeout?: number }) =>
      expect(saveStatus).toHaveAttribute(
        "data-room-document-save-status",
        expected,
        options,
      ),
  };
}

export async function appendRoomDocumentText(
  editor: Locator,
  text: string,
  surface: Locator,
) {
  await enterRoomDocumentEditMode(surface);
  const paragraph = editor
    .locator("p")
    .filter({ hasText: "E2E initial state" })
    .first();
  await expect(async () => {
    await paragraph.click();
    // Keep the paragraph click's focus; locator.press would focus the editor again.
    // Each attempt redoes click+End because edit-mode entry or a collaboration
    // re-render can drop the caret after a single End press.
    await editor.page().keyboard.press("End");
    expect(
      await paragraph.evaluate((element) => {
        const selection = element.ownerDocument.getSelection();
        if (
          !selection?.isCollapsed ||
          !selection.anchorNode ||
          !element.contains(selection.anchorNode) ||
          selection.anchorNode.parentElement?.closest(
            '[contenteditable="false"]',
          ) ||
          element.closest('[contenteditable="true"]') !==
            element.ownerDocument.activeElement
        ) {
          return false;
        }
        const remaining = element.ownerDocument.createRange();
        remaining.selectNodeContents(element);
        remaining.setStart(selection.anchorNode, selection.anchorOffset);
        const remainingContent = remaining.cloneContents();
        // Remote cursor widgets contain word joiners, not editable document text.
        remainingContent
          .querySelectorAll('[contenteditable="false"]')
          .forEach((widget) => widget.remove());
        return remainingContent.textContent === "";
      }),
    ).toBe(true);
  }).toPass({ timeout: 10_000 });
  await editor.page().keyboard.insertText(text);
}

export async function waitForRoomDocumentSessionOpened(
  harness: { state(): Promise<{ session_open_success_count: number }> },
  sessionOpensBefore: number,
) {
  // Runtime boot plus a successful TeamHub session open can exceed
  // Playwright's default 5s expect timeout.
  await expect
    .poll(async () => (await harness.state()).session_open_success_count, {
      timeout: 10_000,
    })
    .toBeGreaterThan(sessionOpensBefore);
}

export async function enterRoomDocumentReadMode(surface: Locator) {
  const mode = surface.getByRole("button", {
    name: "Document mode",
    exact: true,
  });
  if ((await mode.textContent())?.includes("Edit mode")) {
    await mode.click();
    await surface
      .page()
      .getByRole("menuitem", { name: "Read", exact: true })
      .click();
  }
  await expect(surface.getByLabel("Room Document editor")).toHaveAttribute(
    "data-editable",
    "false",
    { timeout: 30_000 },
  );
}

export async function enterRoomDocumentEditMode(surface: Locator) {
  const mode = surface.getByRole("button", {
    name: "Document mode",
    exact: true,
  });
  if ((await mode.textContent())?.includes("Read mode")) {
    await mode.click();
    await surface
      .page()
      .getByRole("menuitem", { name: "Edit", exact: true })
      .click();
  }
  await expect(surface.getByLabel("Room Document editor")).toHaveAttribute(
    "data-editable",
    "true",
    { timeout: 30_000 },
  );
}

export async function authenticateRoomDocumentContext(
  context: Pick<BrowserContext, "request">,
) {
  const response = await context.request.post(`${teamHubUrl}/v0/auth/login`, {
    data: {
      identifier: "alice@example.com",
      password: "teamhub-dev-alice",
    },
  });
  if (!response.ok()) {
    throw new Error(
      `Room Document E2E login failed with status ${response.status()}`,
    );
  }
}

async function openDocumentPage(
  page: Page,
  targetUrl: string,
  readyHeading: Locator,
) {
  await blockExternalFonts(page);
  await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  await readyHeading.waitFor({ state: "visible" });
}
