import { expect, test } from "@playwright/test";
import { pw } from "./creds";

// Run by `make migration-test` against a stack restored from a backup of the `make e2e` stack.
test("a restored account still signs in and can read its encrypted library", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("E-mail").fill("frank@example.org");
  await page.getByLabel("Password").fill(pw("frank"));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Timeline" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".tile")).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator(".tile img")).toBeVisible({ timeout: 15_000 }); // thumbnail decrypts with the restored keys
  await page.locator(".tile").first().click();
  await expect(page.locator("dialog.lightbox .stage img")).toBeVisible({ timeout: 15_000 }); // the full photo decrypts too
});
