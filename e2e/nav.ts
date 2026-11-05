import { Page } from "@playwright/test";

/** Account, Admin and Sign out live in the avatar menu at the top right. */
export async function openMenuItem(page: Page, name: "Account" | "Admin" | "Sign out") {
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name }).click();
}
