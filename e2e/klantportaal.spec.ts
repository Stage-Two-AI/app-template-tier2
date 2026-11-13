import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { wachtOpInlogmail } from "../tests/lib/mailvanger";
import { TEST_USER } from "./test-user";

/**
 * Het klantportaal in een echte browser, op het formaat van een telefoon: de app gebouwd met
 * `VITE_INLOGDIENST=cloudflare,mailcode` (zie playwright.config.ts). Een klant logt echt in
 * bij de lokale Supabase, met de code of de link uit de mail in de lokale mailvanger. Er is
 * geen omweg: geen wachtwoord, geen sessie die de test zelf klaarzet.
 *
 * Inloggen voor medewerkers gaat via Cloudflare en is lokaal niet na te spelen; dat de knop
 * er staat, test deze test, en wat een sessie via Cloudflare mag, bewijst
 * tests/rls/klantportaal.test.ts.
 */
const mailUrl = process.env.SUPABASE_MAIL_URL;
const nieuweKlant = `e2e-klant-${Date.now()}@voorbeeld.nl`;
const klantMetLink = `e2e-link-${Date.now()}@voorbeeld.nl`;
const tikfout = `e2e-tikfout-${Date.now()}@voorbeeld.nl`;

// Na elkaar: de tests vragen codes aan, en Supabase stuurt per adres niet vaker dan eens per
// seconde.
test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
  const url = process.env.SUPABASE_URL;
  const sleutel = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !sleutel) return;
  const admin = createClient(url, sleutel, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data } = await admin.auth.admin.listUsers();
  for (const user of data?.users ?? []) {
    if ([nieuweKlant, klantMetLink, tikfout].includes(user.email ?? "")) {
      await admin.auth.admin.deleteUser(user.id);
    }
  }
});

test("een nieuwe klant logt in met de code uit de mail", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Inloggen" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Inloggen voor medewerkers" })).toBeVisible();

  const leesMail = await wachtOpInlogmail({ email: nieuweKlant, mailUrl });
  await page.getByLabel("E-mailadres").fill(nieuweKlant);
  await page.getByRole("button", { name: "Doorgaan" }).click();

  await expect(page.getByRole("heading", { name: "Vul de code in" })).toBeVisible();
  await expect(page.getByText(nieuweKlant)).toBeVisible();
  const codevak = page.getByLabel("Code van acht cijfers");
  await expect(codevak).toBeFocused();
  await expect(codevak).toHaveAttribute("autocomplete", "one-time-code");
  await expect(codevak).toHaveAttribute("inputmode", "numeric");

  const { code } = await leesMail();
  expect(code).toMatch(/^\d{8}$/);
  // Acht cijfers typen is genoeg: de pagina controleert de code dan zelf.
  await codevak.pressSequentially(code);

  await expect(page.getByRole("heading", { name: "Mijn lijst" })).toBeVisible();
  await expect(page.getByText(nieuweKlant)).toBeVisible();

  // En na verversen nog steeds binnen: het is een echte sessie.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Mijn lijst" })).toBeVisible();
});

test("een verkeerde code geeft een nette melding en geen toegang", async ({ page }) => {
  // Een bestaand account (global-setup.ts maakt het aan): die krijgt de mail voor terugkerende
  // klanten, de nieuwe klant hierboven kreeg de mail voor een eerste aanmelding.
  await page.goto("/login");
  const leesMail = await wachtOpInlogmail({ email: TEST_USER.email, mailUrl });
  await page.getByLabel("E-mailadres").fill(TEST_USER.email);
  await page.getByRole("button", { name: "Doorgaan" }).click();
  await expect(page.getByRole("heading", { name: "Vul de code in" })).toBeVisible();

  const { code } = await leesMail();
  const fout = code === "00000000" ? "00000001" : "00000000";
  const codevak = page.getByLabel("Code van acht cijfers");
  await codevak.pressSequentially(fout);
  await expect(page.getByRole("alert")).toContainText("Deze code klopt niet");
  await expect(page.getByRole("heading", { name: "Mijn lijst" })).toBeHidden();

  // Daarna de goede code: de klant is binnen.
  await codevak.fill("");
  await codevak.pressSequentially(code);
  await expect(page.getByRole("heading", { name: "Mijn lijst" })).toBeVisible();
});

test("een verkeerd adres is aan te passen", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("E-mailadres").fill(tikfout);
  await page.getByRole("button", { name: "Doorgaan" }).click();
  await expect(page.getByRole("heading", { name: "Vul de code in" })).toBeVisible();
  await page.getByRole("button", { name: "Ander e-mailadres" }).click();
  await expect(page.getByLabel("E-mailadres")).toHaveValue(tikfout);
  await expect(page.getByRole("button", { name: "Inloggen voor medewerkers" })).toBeVisible();
});

test("de link uit de mail werkt ook, in een andere browser dan waar de code is aangevraagd", async ({
  page,
  browser,
}) => {
  await page.goto("/login");
  const leesMail = await wachtOpInlogmail({ email: klantMetLink, mailUrl });
  await page.getByLabel("E-mailadres").fill(klantMetLink);
  await page.getByRole("button", { name: "Doorgaan" }).click();
  await expect(page.getByRole("heading", { name: "Vul de code in" })).toBeVisible();
  const { link } = await leesMail();
  expect(new URL(link).pathname).toBe("/login");

  // Een link uit WhatsApp of Gmail opent vaak in een andere browser: een verse context.
  const andere = await browser.newContext();
  const derde = await browser.newContext();
  try {
    const tab = await andere.newPage();
    await tab.goto(link);
    // Openen alleen logt niet in; pas de klik doet dat.
    await expect(tab.getByRole("heading", { name: "Inloggen" })).toBeVisible();
    await tab.getByRole("button", { name: "Inloggen" }).click();
    await expect(tab.getByRole("heading", { name: "Mijn lijst" })).toBeVisible();
    await expect(tab.getByText(klantMetLink)).toBeVisible();

    // De link werkt één keer.
    const opnieuw = await derde.newPage();
    await opnieuw.goto(link);
    await opnieuw.getByRole("button", { name: "Inloggen" }).click();
    await expect(opnieuw.getByRole("alert")).toContainText("verlopen of al gebruikt");
  } finally {
    await andere.close();
    await derde.close();
  }
});
