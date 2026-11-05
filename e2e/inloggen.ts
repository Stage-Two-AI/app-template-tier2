import { expect, type Page } from "@playwright/test";
import { TEST_USER } from "./test-user";

/**
 * Inloggen als de e2e-gebruiker via het inlogformulier. global-setup.ts maakt die gebruiker
 * aan (en geeft hem de rol uit supabase/testrol.sql, als dat bestand er is).
 */
export async function inloggen(page: Page): Promise<void> {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Inloggen" })).toBeVisible();
  await page.getByLabel("E-mailadres").fill(TEST_USER.email);
  await page.getByLabel("Wachtwoord").fill(TEST_USER.password);
  await page.getByRole("button", { name: "Inloggen" }).click();
  await expect(page.getByRole("heading", { name: "Inloggen" })).toBeHidden();
}
