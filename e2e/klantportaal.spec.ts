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
const vreemde = `e2e-vreemde-${Date.now()}@voorbeeld.nl`;
const metScanner = `e2e-scanner-${Date.now()}@voorbeeld.nl`;
const alleAdressen = [nieuweKlant, klantMetLink, tikfout, vreemde, metScanner];

/** Supabase buiten de browser om, zoals iemand met een eigen script. */
function buitenom() {
  return createClient(process.env.SUPABASE_URL ?? "", process.env.SUPABASE_ANON_KEY ?? "", {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

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
    if (alleAdressen.includes(user.email ?? "")) {
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
  const codevak = page.getByLabel("Code van tien cijfers");
  await expect(codevak).toBeFocused();
  await expect(codevak).toHaveAttribute("autocomplete", "one-time-code");
  await expect(codevak).toHaveAttribute("inputmode", "numeric");

  const { code } = await leesMail();
  expect(code).toMatch(/^\d{10}$/);
  // Tien cijfers typen is genoeg: de pagina controleert de code dan zelf.
  await codevak.pressSequentially(code);

  await expect(page.getByRole("heading", { name: "Mijn lijst" })).toBeVisible();
  // Kort na het inloggen staat bovenin op welk adres je binnen bent.
  await expect(page.getByTestId("ingelogd-als")).toContainText(nieuweKlant);
  // Het tabblad onthoudt het adres niet langer.
  expect(await page.evaluate(() => window.sessionStorage.getItem("inlogcode"))).toBeNull();

  // En na verversen nog steeds binnen: het is een echte sessie.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Mijn lijst" })).toBeVisible();
  await expect(page.getByTestId("ingelogd-als")).toBeHidden();

  // Wie al binnen is en naar /login gaat, komt bij de knop voor medewerkers zonder eerst uit
  // te loggen.
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Je bent al ingelogd" })).toBeVisible();
  await expect(page.getByText(nieuweKlant)).toBeVisible();
  await expect(page.getByRole("button", { name: "Inloggen voor medewerkers" })).toBeVisible();
  await page.getByRole("link", { name: "Verder naar de app" }).click();
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
  const fout = code === "0000000000" ? "0000000001" : "0000000000";
  const codevak = page.getByLabel("Code van tien cijfers");
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
  await expect(
    page.getByText("Werk je hier? Gebruik de knop Inloggen voor medewerkers."),
  ).toBeVisible();
});

test("de link uit de mail werkt ook, in een andere browser dan waar de code is aangevraagd", async ({
  page,
  browser,
  context,
  baseURL,
}) => {
  await page.goto("/login");
  const leesMail = await wachtOpInlogmail({ email: klantMetLink, mailUrl });
  await page.getByLabel("E-mailadres").fill(klantMetLink);
  await page.getByRole("button", { name: "Doorgaan" }).click();
  await expect(page.getByRole("heading", { name: "Vul de code in" })).toBeVisible();
  const { link } = await leesMail();
  // De link gaat naar de inlogpagina van de app zelf.
  expect(link.startsWith(`${baseURL}/login?token_hash=`)).toBe(true);

  // In een nieuw tabblad van dezelfde browser: de mail is hier aangevraagd, dus geen
  // waarschuwing. Openen alleen logt niet in.
  const nieuwTabblad = await context.newPage();
  await nieuwTabblad.goto(link);
  await expect(nieuwTabblad.getByText("Je bent er bijna.")).toBeVisible();
  await expect(nieuwTabblad.getByTestId("link-waarschuwing")).toBeHidden();
  await nieuwTabblad.close();

  // Een link uit WhatsApp of Gmail opent vaak in een andere browser: een verse context.
  const andere = await browser.newContext();
  const derde = await browser.newContext();
  try {
    const tab = await andere.newPage();
    await tab.goto(link);
    // Openen alleen logt niet in; pas de klik doet dat. Deze browser vroeg de mail niet aan:
    // de pagina vraagt het eerst na.
    await expect(tab.getByRole("heading", { name: "Inloggen" })).toBeVisible();
    await expect(tab.getByTestId("link-waarschuwing")).toContainText(
      "Heb je deze mail zelf aangevraagd?",
    );
    await tab.getByRole("button", { name: "Inloggen" }).click();
    await expect(tab.getByRole("heading", { name: "Mijn lijst" })).toBeVisible();
    await expect(tab.getByTestId("ingelogd-als")).toContainText(klantMetLink);

    // Na gebruik werkt de link niet nog een keer.
    const opnieuw = await derde.newPage();
    await opnieuw.goto(link);
    await opnieuw.getByRole("button", { name: "Inloggen" }).click();
    await expect(opnieuw.getByRole("alert")).toContainText("verlopen of al gebruikt");
  } finally {
    await andere.close();
    await derde.close();
  }
});

test("een link uit de mail van een ander: de pagina waarschuwt eerst en zegt daarna in wiens account je zit", async ({
  page,
}) => {
  // Iemand vraagt buiten de browser om een code aan op zijn eigen adres en stuurt de link uit
  // zijn eigen mail naar een klant. Die klant zou ongemerkt in het account van de ander
  // inloggen en daar zijn gegevens invullen.
  const leesMail = await wachtOpInlogmail({ email: vreemde, mailUrl });
  const { error } = await buitenom().auth.signInWithOtp({ email: vreemde });
  expect(error).toBeNull();
  const { link } = await leesMail();

  await page.goto(link);
  await expect(page.getByTestId("link-waarschuwing")).toContainText(
    "dan kom je in het account van die ander",
  );
  await expect(page.getByRole("heading", { name: "Mijn lijst" })).toBeHidden();
  // Wie toch doorklikt, ziet meteen op welk adres hij binnen is.
  await page.getByRole("button", { name: "Inloggen" }).click();
  await expect(page.getByTestId("ingelogd-als")).toContainText(vreemde);
});

test("een link met de sessie van een ander in het adres logt niemand in", async ({ page }) => {
  const leesMail = await wachtOpInlogmail({ email: vreemde, mailUrl });
  // Supabase stuurt per adres niet vaker dan eens per seconde.
  await page.waitForTimeout(1500);
  const client = buitenom();
  await client.auth.signInWithOtp({ email: vreemde });
  const { code } = await leesMail();
  const { data } = await client.auth.verifyOtp({ email: vreemde, token: code, type: "email" });
  expect(data.session).not.toBeNull();
  const fragment = new URLSearchParams({
    access_token: data.session?.access_token ?? "",
    refresh_token: data.session?.refresh_token ?? "",
    expires_in: "3600",
    token_type: "bearer",
    type: "magiclink",
  });
  await page.goto(`/login#${fragment.toString()}`);
  await expect(page.getByRole("heading", { name: "Inloggen" })).toBeVisible();
  await page.waitForTimeout(2000);
  await expect(page.getByRole("heading", { name: "Mijn lijst" })).toBeHidden();
  await expect(page.getByLabel("E-mailadres")).toBeVisible();
});

test("tekst uit het adres komt niet op het inlogscherm, en kiest ook geen melding", async ({
  page,
}) => {
  const tekst = "Bel 0900-1234 en geef uw code door";
  const q = encodeURIComponent(`<img src=x onerror="document.title='gekaapt'"><b>${tekst}</b>`);
  await page.goto(
    `/login?error=${q}&error_code=${q}&error_description=${q}&code=${q}#error_description=${q}`,
  );
  await expect(page.getByRole("heading", { name: "Inloggen" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText("Inloggen is niet gelukt. Probeer het opnieuw.");
  await expect(page.locator("body")).not.toContainText("0900");
  expect(await page.title()).not.toContain("gekaapt");

  // De uitleg voor een nieuwe medewerker ("klik op de link in die mail") is er alleen voor wie
  // zelf net op de knop voor medewerkers klikte, niet voor wie een link kreeg.
  await page.goto(
    "/login?error=access_denied&error_code=provider_email_needs_verification&error_description=Unverified+email+with+custom%3Acloudflare.+A+confirmation+email+has+been+sent",
  );
  await expect(page.getByRole("alert")).toHaveText("Inloggen is niet gelukt. Probeer het opnieuw.");
});

test("na het inloggen blijft de klant op de app, wat er ook in het adres stond", async ({
  page,
}) => {
  await page.goto(
    "/login?redirect_to=https://ander.example/&next=https://ander.example/&returnTo=//ander.example/",
  );
  const leesMail = await wachtOpInlogmail({ email: tikfout, mailUrl });
  // Supabase stuurt per adres niet vaker dan eens per seconde.
  await page.waitForTimeout(1500);
  await page.getByLabel("E-mailadres").fill(tikfout);
  await page.getByRole("button", { name: "Doorgaan" }).click();
  const { code } = await leesMail();
  await page.getByLabel("Code van tien cijfers").pressSequentially(code);
  await expect(page.getByRole("heading", { name: "Mijn lijst" })).toBeVisible();
  expect(new URL(page.url()).hostname).toBe("127.0.0.1");
  expect(new URL(page.url()).pathname).toBe("/");
});

test("een scanner die de pagina van de link echt opent, verbruikt de link niet", async ({
  page,
  browser,
}) => {
  const leesMail = await wachtOpInlogmail({ email: metScanner, mailUrl });
  await buitenom().auth.signInWithOtp({ email: metScanner });
  const { link } = await leesMail();
  // Een virusscanner of mailprogramma opent de link vooraf, met JavaScript aan, en ververst.
  const scanner = await browser.newContext();
  try {
    const tab = await scanner.newPage();
    await tab.goto(link);
    await expect(tab.getByRole("button", { name: "Inloggen" })).toBeVisible();
    await tab.reload();
    await expect(tab.getByRole("button", { name: "Inloggen" })).toBeVisible();
  } finally {
    await scanner.close();
  }
  // Daarna de klant zelf: de link werkt nog.
  await page.goto(link);
  await page.getByRole("button", { name: "Inloggen" }).click();
  await expect(page.getByRole("heading", { name: "Mijn lijst" })).toBeVisible();
  await expect(page.getByTestId("ingelogd-als")).toContainText(metScanner);
});
