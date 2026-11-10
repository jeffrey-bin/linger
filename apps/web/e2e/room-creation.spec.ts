import { expect, test } from "@playwright/test";
import {
  blockExternalFonts,
  openRoomChat,
} from "./room-document-collaboration-test-support";
import { RoomDocumentE2EHarnessClient } from "./room-document-e2e-harness-client";

test.afterEach(async ({ request }) => {
  await new RoomDocumentE2EHarnessClient(request).cleanup();
});

test("creates the Room before optional membership and persists the second step", async ({
  browser,
  request,
}, testInfo) => {
  const harness = new RoomDocumentE2EHarnessClient(request);
  const fixture = await harness.reset();
  // Only an Agent can join; @official needs its Computer online to be offered.
  await harness.connectOwnerComputer();
  const alice = await openRoomChat(browser, fixture);
  try {
    const navigation = alice.page.getByRole("navigation", {
      name: "Room navigation",
      exact: true,
    });
    await navigation
      .getByRole("button", { name: "Create chat", exact: true })
      .click();
    await alice.page
      .getByRole("menuitem", { name: "Create Room", exact: true })
      .click();
    const create = alice.page.getByRole("dialog", {
      name: "Create Room",
      exact: true,
    });
    await expect(create.getByRole("textbox")).toHaveCount(1);
    await create.getByLabel("Room name").fill("Two step durable proof");
    await create
      .getByRole("button", { name: "Create Room", exact: true })
      .click();
    const members = alice.page.getByRole("dialog", {
      name: "Add Room members",
    });
    await expect(members).toBeVisible();
    await expect(alice.page).toHaveURL(/\/rooms\/[^/]+\/chat$/);
    const roomId = new URL(alice.page.url()).pathname.split("/").at(-2)!;
    const getMembers = () =>
      alice.context.request
        .get(new URL(`/v0/rooms/${roomId}/members`, alice.page.url()).href)
        .then(async (response) => {
          expect(response.ok()).toBe(true);
          return response.json();
        });
    const before = await getMembers();
    expect(
      before.items.some(
        (member: { actor: { id: string } }) =>
          member.actor.id === "actor_acme_official",
      ),
    ).toBe(false);
    await members
      .getByRole("button", { name: "Choose existing members" })
      .click();
    const picker = alice.page.getByRole("dialog", { name: "Choose members" });
    await picker.getByLabel("Search members").fill("official");
    await picker.getByRole("button", { name: /official/i }).click();
    await picker.getByLabel("Search members").press("Escape");
    await members
      .getByRole("button", { name: "Add members", exact: true })
      .click();
    await expect(members).toHaveCount(0);
    await expect
      .poll(async () =>
        (await getMembers()).items.map(
          (member: { actor: { id: string } }) => member.actor.id,
        ),
      )
      .toContain("actor_acme_official");
    await alice.page.reload();
    await expect(
      alice.page.getByRole("heading", {
        name: "Two step durable proof",
        exact: true,
      }),
    ).toBeVisible();
    await expect(members).toHaveCount(0);
    await alice.page.screenshot({
      path: testInfo.outputPath("created-room.png"),
    });
    // Another browser of the same Human sees the persisted membership.
    const otherContext = await browser.newContext();
    try {
      const page = await otherContext.newPage();
      await blockExternalFonts(page);
      await page.goto(new URL("/login", alice.page.url()).href);
      await page.getByLabel("Email").fill("alice@example.com");
      await page
        .getByLabel("Password", { exact: true })
        .fill("teamhub-dev-alice");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.waitForURL(/\/t\//);
      await page.goto(
        new URL(
          `/t/${fixture.tenant_id}/rooms/${roomId}/chat`,
          alice.page.url(),
        ).href,
      );
      await expect(
        page.getByRole("heading", {
          name: "Two step durable proof",
          exact: true,
        }),
      ).toBeVisible();
      await page
        .getByRole("button", {
          name: "Open Two step durable proof settings from avatar",
        })
        .click();
      const roster = page.getByRole("region", { name: "Room members" });
      await expect(roster.getByText(/official/)).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath("agent-membership.png"),
      });
    } finally {
      await otherContext.close();
    }
  } finally {
    await alice.context.close();
  }
});

test("leaves and rejoins through Room settings while preserving role on every session", async ({
  browser,
  request,
}, testInfo) => {
  const fixture = await new RoomDocumentE2EHarnessClient(request).reset();
  const alice = await openRoomChat(browser, fixture);
  const otherAlice = await openRoomChat(browser, fixture);
  const roomUrl = new URL(
    `/t/${fixture.tenant_id}/rooms/${fixture.room_id}/chat`,
    alice.page.url(),
  ).href;
  try {
    const room = alice.page.locator(".app-room-surface");
    const timeline = room.getByLabel("Room timeline", { exact: true });
    const name = await room.getByRole("heading").first().textContent();
    await alice.page
      .getByLabel("Message Room", { exact: true })
      .fill("Before leaving proof");
    await alice.page.getByLabel("Message Room", { exact: true }).press("Enter");
    await expect(
      timeline.getByText("Before leaving proof", { exact: true }),
    ).toBeVisible();
    await alice.page
      .getByRole("button", { name: /settings from avatar$/ })
      .click();
    const panel = alice.page.getByTestId("panel-room-settings");
    await expect(panel).toBeVisible();
    await expect(
      alice.page.getByRole("dialog", { name: "Room settings", exact: true }),
    ).toHaveCount(0);
    // The owner's edit control is what shows the panel rendered.
    await expect(
      panel.getByRole("button", { name: "Edit Room details" }),
    ).toBeVisible();
    await panel
      .getByRole("button", { name: "Leave Room", exact: true })
      .click();
    const confirmation = alice.page.getByRole("dialog", {
      name: "Leave Room",
      exact: true,
    });
    await expect(confirmation).toContainText(
      "Your role, existing access and message history stay the same",
    );
    await confirmation
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(
      room.getByLabel("Message Room", { exact: true }),
    ).toBeVisible();
    await panel
      .getByRole("button", { name: "Leave Room", exact: true })
      .click();
    await alice.page.screenshot({
      path: testInfo.outputPath("leave-confirmation.png"),
    });
    await confirmation
      .getByRole("button", { name: "Leave", exact: true })
      .click();
    await expect(confirmation).toHaveCount(0);
    await expect(
      room.getByRole("button", { name: `Join ${name}` }),
    ).toBeVisible();
    await expect(room.getByLabel("Message Room", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      otherAlice.page
        .locator(".app-room-surface")
        .getByRole("button", { name: `Join ${name}` }),
    ).toBeVisible();
    await alice.page.reload();
    await expect(
      room.getByRole("button", { name: `Join ${name}` }),
    ).toBeVisible();
    await expect(
      timeline.getByText("Before leaving proof", { exact: true }),
    ).toBeVisible();
    await alice.page.screenshot({ path: testInfo.outputPath("left-room.png") });
    await room.getByRole("button", { name: `Join ${name}` }).click();
    await expect(
      room.getByLabel("Message Room", { exact: true }),
    ).toBeVisible();
    await expect(
      otherAlice.page.getByLabel("Message Room", { exact: true }),
    ).toBeVisible();
    await alice.page
      .getByRole("button", { name: /settings from avatar$/ })
      .click();
    await expect(
      panel.getByRole("button", { name: "Edit Room details" }),
    ).toBeVisible();
    await alice.page.screenshot({
      path: testInfo.outputPath("rejoined-owner.png"),
    });
    // A link to a Room the Human cannot open shows the friendly page.
    const unavailableRoomId = `room_missing_${fixture.room_id}`;
    await otherAlice.page.goto(
      new URL(
        `/t/${fixture.tenant_id}/rooms/${unavailableRoomId}/chat`,
        roomUrl,
      ).href,
    );
    await expect(
      otherAlice.page.getByRole("heading", {
        name: "This Room is not available to you",
      }),
    ).toBeVisible();
    await expect(
      otherAlice.page.getByText(
        /ask the person who shared this link to invite you/i,
      ),
    ).toBeVisible();
    await expect(
      otherAlice.page.getByText("resource was not found", { exact: true }),
    ).toHaveCount(0);
    await otherAlice.page.screenshot({
      path: testInfo.outputPath("friendly-unavailable.png"),
    });
    await otherAlice.page
      .getByRole("button", { name: "Back to my Rooms" })
      .click();
    await expect(otherAlice.page).not.toHaveURL(new RegExp(unavailableRoomId));
  } finally {
    await Promise.all([alice.context.close(), otherAlice.context.close()]);
  }
});

test("shares a frozen Room conversation with an anonymous reader and revokes access", async ({
  browser,
  request,
}, testInfo) => {
  const fixture = await new RoomDocumentE2EHarnessClient(request).reset();
  const alice = await openRoomChat(browser, fixture);
  const guest = await browser.newContext();
  try {
    const composer = alice.page.getByLabel("Message Room");
    await alice.page.getByLabel("Choose message attachments").setInputFiles({
      name: "snapshot-pixel.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=",
        "base64",
      ),
    });
    await composer.fill(
      "**Shared snapshot proof**\n\n[External website](https://example.com)",
    );
    await alice.page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    const sharedMessage = alice.page
      .locator("article[data-message-id]")
      .filter({ hasText: "Shared snapshot proof" });
    await expect(sharedMessage).toHaveCount(1);
    await expect(sharedMessage).toBeVisible();
    await alice.page
      .getByRole("button", { name: /settings from avatar$/ })
      .click();
    await alice.page
      .getByRole("button", { name: "Share conversation", exact: true })
      .click();
    const dialog = alice.page.getByRole("dialog", {
      name: "Share conversation",
      exact: true,
    });
    await dialog
      .getByRole("button", { name: "Create share link", exact: true })
      .click();
    // The dialog also has a "Copy conversation link" button, so target the
    // field itself rather than any control whose label contains the phrase.
    const link = dialog.getByRole("textbox", { name: "Conversation link" });
    await expect(link).toHaveValue(/#room_share_/);
    const url = await link.inputValue();
    await alice.page.screenshot({
      path: testInfo.outputPath("share-created.png"),
    });
    const viewer = await guest.newPage();
    await blockExternalFonts(viewer);
    await viewer.goto(url);
    await expect(
      viewer.getByText("Shared snapshot proof", { exact: true }),
    ).toHaveJSProperty("tagName", "STRONG");
    await expect(viewer.getByRole("textbox")).toHaveCount(0);
    await expect(
      viewer.getByRole("link", { name: "External website" }),
    ).toHaveAttribute("href", "https://example.com");
    const picture = viewer.getByRole("img", {
      name: "snapshot-pixel.png",
      exact: true,
    });
    await expect(picture).toBeVisible();
    await expect
      .poll(() =>
        picture.evaluate(
          (element) => (element as HTMLImageElement).naturalWidth,
        ),
      )
      .toBe(1);
    await viewer.screenshot({
      path: testInfo.outputPath("anonymous-snapshot.png"),
      fullPage: true,
    });
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await composer.fill("After snapshot should remain private");
    await alice.page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    const privateMessage = alice.page
      .locator("article[data-message-id]")
      .filter({ hasText: "After snapshot should remain private" });
    await expect(privateMessage).toHaveCount(1);
    await expect(privateMessage).toBeVisible();
    await viewer.reload();
    await expect(
      viewer.getByText("Shared snapshot proof", { exact: true }),
    ).toBeVisible();
    await expect(
      viewer.getByText("After snapshot should remain private"),
    ).toHaveCount(0);
    await alice.page
      .getByRole("button", { name: "Share conversation", exact: true })
      .click();
    await dialog.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(dialog.getByText("Revoked", { exact: true })).toBeVisible();
    await viewer.reload();
    await expect(viewer.getByRole("alert")).toContainText(
      "unavailable or has been revoked",
    );
    await expect(
      viewer.getByText("Shared snapshot proof", { exact: true }),
    ).toHaveCount(0);
    await viewer.screenshot({ path: testInfo.outputPath("share-revoked.png") });
  } finally {
    await alice.context.close();
    await guest.close();
  }
});
