import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { wachtOpInlogmail } from "../tests/lib/mailvanger";

/**
 * AANVAL ronde 2, doel 5, in een echte browser tegen de lokale Supabase (de app gebouwd als
 * klantportaal, zie playwright.config.ts). Elke test SLAAGT als de aanval lukt.
 */
const mailUrl = process.env.SUPABASE_MAIL_URL;
const slachtoffer = `aanval2-slachtoffer-${Date.now()}@voorbeeld.nl`;
const aanvaller = `aanval2-aanvaller-${Date.now()}@voorbeeld.nl`;
const alleAdressen = [slachtoffer, aanvaller];

function buitenom() {
  return createClient(process.env.SUPABASE_URL ?? "", process.env.SUPABASE_ANON_KEY ?? "", {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

test.describe.configure({ mode: "serial", retries: 0 });

test.afterAll(async () => {
  const url = process.env.SUPABASE_URL;
  const sleutel = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !sleutel) return;
  const admin = createClient(url, sleutel, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data } = await admin.auth.admin.listUsers();
  for (const user of data?.users ?? []) {
    if (alleAdressen.includes(user.email ?? "")) await admin.auth.admin.deleteUser(user.id);
  }
});

test("5.1 GELUKT ALS: na een eigen aanvraag (uitgelokt met een link die 'verlopen' zegt) opent de link van de aanvaller zonder waarschuwing, en het slachtoffer zit in zijn account", async ({
  page,
  context,
}) => {
  // De aanvaller vraagt buiten de browser om een code aan op zijn eigen adres.
  const mailVanAanvaller = await wachtOpInlogmail({ email: aanvaller, mailUrl });
  const { error } = await buitenom().auth.signInWithOtp({ email: aanvaller });
  expect(error).toBeNull();
  const { link: linkVanAanvaller } = await mailVanAanvaller();

  // Mail 1 aan het slachtoffer: een link naar de echte inlogpagina. De aanvaller kiest met
  // het adres welke melding er staat.
  await page.goto("/login?error_code=otp_expired");
  await expect(page.getByRole("alert")).toContainText("Vraag hieronder een nieuwe code aan");
  await page.getByLabel("E-mailadres").fill(slachtoffer);
  await page.getByRole("button", { name: "Doorgaan" }).click();
  await expect(page.getByRole("heading", { name: "Vul de code in" })).toBeVisible();

  // Mail 2: de link uit de mail van de aanvaller, in een nieuw tabblad van dezelfde browser.
  const tabblad = await context.newPage();
  await tabblad.goto(linkVanAanvaller);
  await expect(tabblad.getByText("Je bent er bijna.")).toBeVisible();
  await expect(tabblad.getByTestId("link-waarschuwing")).toBeHidden();
  await tabblad.getByRole("button", { name: "Inloggen" }).click();
  await expect(tabblad.getByRole("heading", { name: "Mijn lijst" })).toBeVisible();
  // Het slachtoffer zit in het account van de aanvaller.
  await expect(tabblad.getByTestId("ingelogd-als")).toContainText(aanvaller);
});
