import { expect, test, type Locator, type Page } from "@playwright/test";
import { blockExternalFonts } from "./room-document-collaboration-test-support";
import { RoomDocumentE2EHarnessClient } from "./room-document-e2e-harness-client";

test.use({ actionTimeout: 20_000 });

const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday"];

async function signIn(page: Page) {
  await blockExternalFonts(page);
  await page.goto("/login");
  await page.getByLabel("Email").fill("alice@example.com");
  await page.getByLabel("Password", { exact: true }).fill("teamhub-dev-alice");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/t\//);
}

const agentActorId = "actor_acme_official";

// Routines live in Agent details: open the seeded Agent's panel tab from the
// profile link and switch to its Routines tab. A routine opens in a dialog.
async function openRoutines(page: Page, roomUrl: string) {
  await page.goto(`${roomUrl}?profile=${agentActorId}`);
  await expect(
    page.getByRole("textbox", { name: "Message Room", exact: true }),
  ).toBeVisible();
  const showSidebar = page.getByRole("button", {
    name: "Show sidebar",
    exact: true,
  });
  if (await showSidebar.isVisible()) await showSidebar.click();
  const profile = page.getByTestId("panel-tab-agent-info");
  await profile.getByRole("tab", { name: "Routines", exact: true }).click();
  const panel = profile.getByRole("region", { name: "Routines", exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

async function chooseWhen(page: Page, dialog: Locator, label: string) {
  await dialog.getByRole("combobox", { name: "When", exact: true }).click();
  await page.getByRole("option", { name: label, exact: true }).click();
}

async function openSavedRoutine(page: Page, panel: Locator) {
  await panel.getByRole("button", { name: /Weekly multi-day proof/ }).click();
  return page.getByRole("dialog", { name: "Edit routine" });
}

test("weekly routine creates one persisted selection, reopens, edits and fires once", async ({
  browser,
  request,
}, testInfo) => {
  const harness = new RoomDocumentE2EHarnessClient(request);
  const fixture = await harness.reset();
  const context = await browser.newContext({ timezoneId: "Asia/Shanghai" });
  const page = await context.newPage();
  const roomUrl = `/t/${fixture.tenant_id}/rooms/${fixture.room_id}/chat`;
  const readRoutines = async (activePage: Page) => {
    const response = await activePage.request.get(
      `/v0/rooms/${fixture.room_id}/routines`,
    );
    expect(response.ok()).toBe(true);
    return (await response.json()).items;
  };
  try {
    await test.step("Create one Mon–Fri routine through Agent details", async () => {
      await signIn(page);
      const joined = await page.request.put(
        `/v0/rooms/${fixture.room_id}/members/${agentActorId}`,
        { data: { role: "member" } },
      );
      expect(joined.ok()).toBe(true);
      const panel = await openRoutines(page, roomUrl);
      await panel.getByRole("button", { name: "New routine" }).click();
      const dialog = page.getByRole("dialog", { name: "New routine" });
      await dialog
        .getByLabel("Instruction", { exact: true })
        .fill("Weekly multi-day proof");
      await chooseWhen(page, dialog, "Weekdays");
      await dialog
        .getByRole("textbox", { name: "Hour", exact: true })
        .fill("21");
      await dialog
        .getByRole("textbox", { name: "Minute", exact: true })
        .fill("00");
      await dialog.getByText("When", { exact: true }).click();
      await page.screenshot({
        path: testInfo.outputPath("weekly-selection.png"),
      });
      await dialog.getByRole("button", { name: "Create", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(
        panel.getByText("Weekly multi-day proof", { exact: true }),
      ).toBeVisible();
      await expect(panel.getByText(/Mon–Fri/)).toBeVisible();
      const saved = await readRoutines(page);
      expect(saved).toHaveLength(1);
      expect(saved[0].mention_actor_id).toBe(agentActorId);
      expect(saved[0].cadence).toEqual({
        kind: "weekly",
        timezone: "Asia/Shanghai",
        hour: 21,
        minute: 0,
        weekdays,
      });
      await testInfo.attach("created-routine.json", {
        body: JSON.stringify(saved),
        contentType: "application/json",
      });
    });
    await test.step("Reopen in a fresh session and edit the saved days", async () => {
      const fresh = await browser.newContext({
        timezoneId: "America/New_York",
      });
      try {
        const reopened = await fresh.newPage();
        await signIn(reopened);
        const panel = await openRoutines(reopened, roomUrl);
        const dialog = await openSavedRoutine(reopened, panel);
        for (const day of [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
        ])
          await expect(
            dialog.getByRole("checkbox", { name: day, exact: true }),
          ).toBeChecked();
        await expect(
          dialog.getByRole("checkbox", { name: "Saturday", exact: true }),
        ).not.toBeChecked();
        await dialog.getByText("Tue", { exact: true }).click();
        await expect(
          dialog.getByRole("checkbox", { name: "Tuesday", exact: true }),
        ).not.toBeChecked();
        await dialog.getByRole("button", { name: "Save", exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(panel.getByText(/Mon, Wed, Thu, Fri/)).toBeVisible();
        const saved = await readRoutines(reopened);
        expect(saved).toHaveLength(1);
        expect(saved[0].cadence.weekdays).toEqual([
          "monday",
          "wednesday",
          "thursday",
          "friday",
        ]);
        expect(saved[0].cadence.timezone).toBe("Asia/Shanghai");
        await reopened.screenshot({
          path: testInfo.outputPath("weekly-reopened.png"),
        });
      } finally {
        await fresh.close();
      }
    });
    await test.step("Fire the saved due time once and advance to the next selected date", async () => {
      const panel = await openRoutines(page, roomUrl);
      const dialog = await openSavedRoutine(page, panel);
      await chooseWhen(page, dialog, "Every day");
      // A due time well ahead of the wall clock; the harness releases the
      // occurrence job early so the test does not wait for a natural minute.
      const due = new Date(Date.now() + 2 * 60 * 60 * 1000);
      const clock = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Shanghai",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .format(due)
        .split(":");
      await dialog
        .getByRole("textbox", { name: "Hour", exact: true })
        .fill(clock[0]!);
      await dialog
        .getByRole("textbox", { name: "Minute", exact: true })
        .fill(clock[1]!);
      await dialog.getByText("When", { exact: true }).click();
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(
        panel.getByText("Weekly multi-day proof", { exact: true }),
      ).toBeVisible();
      const before = (await readRoutines(page))[0];
      // A Routine created from Agent details mentions that Agent, so its fire
      // is a hidden agent_runtime wake, not a timeline Message. Prove the
      // single fire through the Room synchronization log instead.
      const since = await page.request.get(
        `/v0/rooms/${fixture.room_id}/events?limit=1`,
      );
      expect(since.ok()).toBe(true);
      const afterSeq = (await since.json()).latest_room_seq as number;
      const fires = async () => {
        const response = await page.request.get(
          `/v0/rooms/${fixture.room_id}/events?after=${afterSeq}&limit=100`,
        );
        expect(response.ok()).toBe(true);
        return (await response.json()).items.filter(
          (event: {
            event_type: string;
            payload: { routine_id?: string; change_kind?: string };
          }) =>
            event.event_type === "routine.changed" &&
            event.payload.routine_id === before.id &&
            event.payload.change_kind === "fired",
        );
      };
      await harness.fireRoutineOccurrence(before.id);
      await expect
        .poll(async () => (await fires()).length, {
          timeout: 15_000,
          intervals: [250],
        })
        .toBe(1);
      const after = (await readRoutines(page))[0];
      expect(after.id).toBe(before.id);
      expect(
        Date.parse(after.next_run_at) - Date.parse(before.next_run_at),
      ).toBe(24 * 60 * 60 * 1000);
      await page.screenshot({ path: testInfo.outputPath("weekly-fired.png") });
      await testInfo.attach("trigger-proof.json", {
        body: JSON.stringify({ before, after, fires: await fires() }),
        contentType: "application/json",
      });
    });
  } finally {
    try {
      await context.close();
    } finally {
      await harness.cleanup();
    }
  }
});
