import { expect, test, type Page } from "@playwright/test";
import { RoomDocumentE2EHarnessClient } from "./room-document-e2e-harness-client";

test.describe.serial("real Cookie login completion", () => {
  test.beforeAll(async ({ request }) => {
    await new RoomDocumentE2EHarnessClient(request).reset();
  });
  test.afterAll(async ({ request }) => {
    await new RoomDocumentE2EHarnessClient(request).cleanup();
  });

  test("a new user lands in the Room through a verified Cookie Session", async ({
    page,
  }) => {
    await signIn(page);
    await expect(page).toHaveURL(/\/rooms\/[^/]+\/chat$/);
    await expect(
      page.getByRole("textbox", { name: "Message Room" }),
    ).toBeVisible();
  });

  test("return_to keeps the Local Computer setup destination", async ({
    page,
  }) => {
    const target = `/connect-computer?code_challenge=${"A".repeat(43)}&display_name=Login%20proof&redirect_uri=http%3A%2F%2F127.0.0.1%3A32199%2Fcallback&state=${"B".repeat(43)}`;
    await signIn(page, target);
    await expect(page).toHaveURL(target);
    await expect(
      page.getByRole("heading", { name: "Connect Login proof" }),
    ).toBeVisible();
  });

  test("a later login returns to the Room and reuses verification", async ({
    page,
  }) => {
    await signIn(page);
    await expect(page).toHaveURL(/\/rooms\/[^/]+\/chat$/);
    // Retire the previous Room before expiring its Cookie. Its in-flight reads
    // may revalidate after logout and are not part of the next login's budget.
    await page.goto("about:blank");
    expect((await page.request.post("/v0/auth/logout")).ok()).toBe(true);
    const getSession: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "GET" && request.url().endsWith("/v0/session"))
        getSession.push(request.url());
    });
    await signIn(page);
    await expect(page).toHaveURL(/\/rooms\/[^/]+\/chat$/);
    await expect(
      page.getByRole("textbox", { name: "Message Room" }),
    ).toBeVisible();
    // One initial /login check and one mandatory post-login Cookie verification.
    expect(getSession).toHaveLength(2);
  });

  test("the account menu logs out and a reloaded Room URL stays on login", async ({
    page,
  }) => {
    await signIn(page);
    await expect(page).toHaveURL(/\/rooms\/[^/]+\/chat$/);
    const roomUrl = page.url();
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Log out", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    // The production SPA host serves the Room route; the Session guard sends
    // it back to login before and after a full reload. The rejected requests
    // may also mark the login as a lapsed session, so only the path is fixed.
    await page.goto(roomUrl);
    await expect(page).toHaveURL(/\/login(\?|$)/);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
  });

  test("a wrong password shows the TeamHub error and keeps the login form", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill("alice@example.com");
    await page.getByLabel("Password", { exact: true }).fill("wrong-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    await page
      .getByLabel("Password", { exact: true })
      .fill("teamhub-dev-alice");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/rooms\/[^/]+\/chat$/);
  });
});

async function signIn(page: Page, returnTo?: string) {
  await page.goto(
    returnTo ? `/login?return_to=${encodeURIComponent(returnTo)}` : "/login",
  );
  await page.getByLabel("Email").fill("alice@example.com");
  await page.getByLabel("Password", { exact: true }).fill("teamhub-dev-alice");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}
