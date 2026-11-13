import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { wachtOpInlogmail } from "../tests/lib/mailvanger";

/**
 * AANVAL, doelen 3 en 4 in een echte browser, tegen de app gebouwd als klantportaal.
 * Elke test SLAAGT als de aanval lukt. Rood betekent: de verdediging hield stand.
 */
const mailUrl = process.env.SUPABASE_MAIL_URL;
const url = process.env.SUPABASE_URL ?? "";
const anonKey = process.env.SUPABASE_ANON_KEY ?? "";
const aanvaller = `e2e-aanvaller-${Date.now()}@voorbeeld.nl`;
const klant = `e2e-aanval-klant-${Date.now()}@voorbeeld.nl`;

test.describe.configure({ mode: "serial", retries: 0 });

function client() {
  return createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

test.afterAll(async () => {
  const sleutel = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !sleutel) return;
  const admin = createClient(url, sleutel, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data } = await admin.auth.admin.listUsers();
  for (const user of data?.users ?? []) {
    if ([aanvaller, klant].includes(user.email ?? "")) await admin.auth.admin.deleteUser(user.id);
  }
});

test("3.20 GELUKT ALS: login-CSRF met token_hash; het slachtoffer klikt op een link en zit in het account van de aanvaller", async ({
  page,
  baseURL,
}) => {
  // De aanvaller vraagt buiten de browser om een code aan op zijn eigen adres en stuurt de
  // link uit zijn eigen mail naar het slachtoffer.
  const leesMail = await wachtOpInlogmail({ email: aanvaller, mailUrl });
  const { error } = await client().auth.signInWithOtp({
    email: aanvaller,
    options: { emailRedirectTo: `${baseURL}/login` },
  });
  expect(error).toBeNull();
  const { link } = await leesMail();
  await page.goto(link);
  // De pagina zegt niet op welk account je inlogt.
  await expect(page.getByText(aanvaller)).toBeHidden();
  await page.getByRole("button", { name: "Inloggen" }).click();
  await expect(page.getByRole("heading", { name: "Mijn lijst" })).toBeVisible();
  await expect(page.getByText(aanvaller)).toBeVisible();
});

test("3.21 login-CSRF zonder klik: een link met het token van de aanvaller in het fragment logt het slachtoffer in", async ({
  page,
}) => {
  const leesMail = await wachtOpInlogmail({ email: aanvaller, mailUrl });
  await new Promise((klaar) => setTimeout(klaar, 1500));
  const c = client();
  await c.auth.signInWithOtp({ email: aanvaller });
  const { code } = await leesMail();
  const { data } = await c.auth.verifyOtp({ email: aanvaller, token: code, type: "email" });
  const sessie = data.session;
  expect(sessie).not.toBeNull();
  const fragment = new URLSearchParams({
    access_token: sessie?.access_token ?? "",
    refresh_token: sessie?.refresh_token ?? "",
    expires_in: "3600",
    token_type: "bearer",
    type: "magiclink",
  });
  await page.goto(`/login#${fragment.toString()}`);
  await expect(page.getByRole("heading", { name: "Mijn lijst" })).toBeVisible({ timeout: 6000 });
});

test("3.22 tekst en opmaak van de aanvaller op het inlogscherm via de adresbalk", async ({ page }) => {
  const tekst = "Bel 0900-1234 en geef uw code door";
  const html = `<img src=x onerror="document.title='gekaapt'"><b id=gekaapt>${tekst}</b>`;
  const q = encodeURIComponent(html);
  await page.goto(`/login?error=${q}&error_code=${q}&error_description=${q}&code=${q}#error_description=${q}`);
  await expect(page.getByRole("heading", { name: "Inloggen" })).toBeVisible();
  const lijf = (await page.locator("body").innerText()) + (await page.title());
  expect(lijf.includes("0900-1234") || lijf.includes("gekaapt")).toBe(true);
});

test("3.23 na inloggen stuurt een parameter in het adres het slachtoffer naar een andere site (open redirect)", async ({
  page,
}) => {
  const leesMail = await wachtOpInlogmail({ email: klant, mailUrl });
  await page.goto("/login?redirect_to=https://aanvaller.example/&next=https://aanvaller.example/&returnTo=//aanvaller.example/");
  await page.getByLabel("E-mailadres").fill(klant);
  await page.getByRole("button", { name: "Doorgaan" }).click();
  const { code } = await leesMail();
  await page.getByLabel("Code van acht cijfers").pressSequentially(code);
  await expect(page.getByRole("heading", { name: "Mijn lijst" })).toBeVisible();
  expect(new URL(page.url()).hostname).toBe("aanvaller.example");
});

test("4.10 een scanner die de pagina van de link echt opent (met JavaScript) verbruikt de link", async ({
  page,
  browser,
  baseURL,
}) => {
  const leesMail = await wachtOpInlogmail({ email: klant, mailUrl });
  await new Promise((klaar) => setTimeout(klaar, 1500));
  await client().auth.signInWithOtp({ email: klant, options: { emailRedirectTo: `${baseURL}/login` } });
  const { link } = await leesMail();
  const scanner = await browser.newContext();
  try {
    const tab = await scanner.newPage();
    await tab.goto(link);
    await tab.waitForTimeout(3000);
    await tab.reload();
    await tab.waitForTimeout(1000);
  } finally {
    await scanner.close();
  }
  // Daarna de klant zelf: gelukt als de link nu dood is.
  await page.goto(link);
  await page.getByRole("button", { name: "Inloggen" }).click();
  await expect(page.getByRole("alert")).toContainText("verlopen of al gebruikt");
});
