import { BrowserContext, Browser, CDPSession, expect, Page, test } from "@playwright/test";
import { pw } from "./creds";
import { openMenuItem } from "./nav";

// Passkeys as the second step on the web (server/passkeys.go), with Chromium's virtual authenticator (CDP WebAuthn
// domain) standing in for a password manager: add one (it turns two-step sign-in on and shows the recovery codes),
// sign in with it in another browser, nothing of the library before, a recovery code still works, removing the last
// passkey turns it off. Chromium only; its own account.
const ADMIN = "admin@example.org";
const ADMIN_PW = pw("admin");
const HEIDI = "heidi@example.org";
const HEIDI_PW = pw("heidi");

test.skip(({ browserName }) => browserName !== "chromium", "the virtual authenticator is Chromium's");

interface Authn { cdp: CDPSession; id: string }

/** A platform authenticator for the page that does user verification and presence by itself. */
async function authenticator(ctx: BrowserContext, page: Page): Promise<Authn> {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { cdp, id: authenticatorId };
}

async function newPage(browser: Browser) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  return { ctx, page };
}

async function passwordStep(page: Page, email: string, password: string) {
  await page.goto("/");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}
const library = (page: Page) => expect(page.getByRole("button", { name: "Timeline" })).toBeVisible({ timeout: 30_000 });

// the passkey made in the first browser, moved into the next one's authenticator (as a synced passkey would be)
let credentials: unknown[] = [];
let codes: string[] = [];

test.describe.serial("passkeys", () => {
  test.setTimeout(180_000);

  test("the server tells Android which app may use its passkeys", async ({ request }) => {
    const r = await request.get("/.well-known/assetlinks.json");
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"]).toContain("application/json");
    const links = await r.json();
    expect(JSON.stringify(links)).toContain("delegate_permission/common.get_login_creds");
    expect(JSON.stringify(links)).toContain("app.cipherfilm");
  });

  test("heidi turns on two-step sign-in with a passkey", async ({ browser }) => {
    const a = await newPage(browser);
    await passwordStep(a.page, ADMIN, ADMIN_PW);
    await library(a.page);
    await openMenuItem(a.page, "Admin");
    await a.page.getByLabel("Their e-mail").fill(HEIDI);
    await a.page.getByRole("button", { name: "Create invite link" }).click();
    const link = await a.page.getByLabel("Invite link").inputValue();
    await a.ctx.close();

    const { ctx, page } = await newPage(browser);
    const auth = await authenticator(ctx, page);
    await page.goto(link);
    await page.getByLabel("Password", { exact: true }).fill(HEIDI_PW);
    await page.getByLabel("Repeat password").fill(HEIDI_PW);
    await page.getByRole("button", { name: "Create account" }).click();
    await page.getByLabel(/I've saved my recovery key/).check({ timeout: 30_000 });
    await page.getByRole("button", { name: "Continue" }).click();
    await library(page);

    await openMenuItem(page, "Account");
    await page.getByText("Two-step sign-in", { exact: true }).click();
    await page.getByRole("button", { name: "Use a passkey…" }).click();
    await page.getByLabel("Name").fill("Test key");
    await page.getByLabel("Your password").fill(HEIDI_PW);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Make the passkey" }).click();
    // the first second step: the recovery codes, shown once
    const list = page.getByRole("list", { name: "Recovery codes" });
    await expect(list.locator("li")).toHaveCount(10, { timeout: 30_000 });
    codes = (await list.locator("li").allInnerTexts()).map((s) => s.trim());
    await page.getByLabel(/I've saved these codes/).check();
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.locator(".passkeys li")).toHaveCount(1);
    await expect(page.locator(".passkeys li")).toContainText("Test key");

    const { credentials: made } = await auth.cdp.send("WebAuthn.getCredentials", { authenticatorId: auth.id });
    expect(made.length).toBe(1);
    credentials = made;
    await ctx.close();
  });

  test("a new sign-in asks for the passkey; nothing of the library before", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    const auth = await authenticator(ctx, page);
    for (const c of credentials) await auth.cdp.send("WebAuthn.addCredential", { authenticatorId: auth.id, credential: c as never });
    await passwordStep(page, HEIDI, HEIDI_PW);
    const use = page.getByRole("button", { name: "Use your passkey" });
    await expect(use).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Timeline" })).toHaveCount(0);
    // no authenticator app on this account: no code field offered first
    await expect(page.getByLabel("Code", { exact: true })).toHaveCount(0);
    await use.click();
    await library(page);
    await ctx.close();
  });

  test("a recovery code still works; removing the last passkey turns it off", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await passwordStep(page, HEIDI, HEIDI_PW);
    await page.getByRole("button", { name: "Use a recovery code" }).click();
    await page.getByLabel("Recovery code").fill(codes[0]);
    await page.getByRole("button", { name: "Sign in" }).click();
    await library(page);

    await openMenuItem(page, "Account");
    await page.getByText("Two-step sign-in", { exact: true }).click();
    await page.locator(".passkeys li").getByRole("button", { name: "Remove…" }).click();
    await expect(page.getByText(/your only second step/)).toBeVisible();
    await page.getByLabel("Your password").fill(HEIDI_PW);
    // this form's field: Change password (closed) asks for the second step with the same label
    await page.locator("#tf-code").fill(codes[1]);
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(page.getByRole("button", { name: "Use a passkey…" })).toBeVisible({ timeout: 30_000 });
    await ctx.close();

    const again = await newPage(browser);
    await passwordStep(again.page, HEIDI, HEIDI_PW);
    await library(again.page); // the password alone again
    await again.ctx.close();
  });
});
