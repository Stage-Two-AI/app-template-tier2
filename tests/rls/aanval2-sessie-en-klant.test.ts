import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin } from "./lib/afscherming";
import { type NepInlogdienst, startNepInlogdienst } from "./lib/inlogdienst-nep";
import {
  accountsVan,
  inloggenMetMailcode,
  metToken,
  nieuwAdres,
  nieuwPersoon,
  noemIdentiteitCloudflare,
  pauze,
  type Sessie,
  sessieViaInlogdienst,
  verwijderAccount,
  zetSessieBegin,
} from "./lib/sessies";

/**
 * AANVAL ronde 2, doel 3 (medewerkerrechten zonder verse Cloudflare-sessie) en doel 4 (een
 * klant die meer kan dan mag).
 *
 * Een test met "GELUKT ALS" slaagt als de aanval lukt. Een test met "MISLUKT" is een aanval die
 * op deze stand niet lukte: hij legt vast wat er is geprobeerd en wordt rood zodra de aanval
 * wel gaat werken.
 */

const url = String(import.meta.env.SUPABASE_URL);
const anonKey = String(import.meta.env.SUPABASE_ANON_KEY);
const opruimen = new Set<string>();
let dienst: NepInlogdienst;

beforeAll(async () => {
  dienst = await startNepInlogdienst();
});

afterAll(async () => {
  for (const id of opruimen) await verwijderAccount(id);
  await dienst?.stop();
});

/** Een medewerker met een verse sessie via de (nagebootste) Cloudflare. */
async function medewerker(label: string) {
  const persoon = nieuwPersoon(label, { adresBevestigd: true });
  const sessie = await sessieViaInlogdienst(persoon);
  for (const id of await accountsVan(persoon)) opruimen.add(id);
  noemIdentiteitCloudflare(sessie.userId);
  const { data } = await sessie.client.rpc("is_medewerker");
  if (data !== true) throw new Error("De opzet klopt niet: de medewerker is geen medewerker.");
  return { persoon, sessie };
}

async function klant(label: string, o: { goedgekeurd: boolean }): Promise<Sessie> {
  const sessie = await inloggenMetMailcode(nieuwAdres(label));
  opruimen.add(sessie.userId);
  await sessie.client.rpc("klant_aanmelden");
  if (o.goedgekeurd) {
    await admin.from("klanten").update({ goedgekeurd: true }).eq("user_id", sessie.userId);
  }
  return sessie;
}

const isMedewerker = async (token: string, headers: Record<string, string> = {}) => {
  const client = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}`, ...headers } },
  });
  return (await client.rpc("is_medewerker")).data === true;
};

describe("AANVAL2 doel 3: medewerkerrechten zonder verse Cloudflare-sessie", () => {
  it("3.1 MISLUKT: race: tijdens en na uitloggen (overal) geeft het oude token nog medewerkerrechten, of het oude verversingstoken een nieuw token", async () => {
    const { sessie } = await medewerker("race");
    const { data: huidige } = await sessie.client.auth.getSession();
    const verversing = huidige.session?.refresh_token ?? "";
    const tijdens = Promise.all(Array.from({ length: 30 }, () => isMedewerker(sessie.token)));
    await sessie.client.auth.signOut({ scope: "global" });
    await tijdens;
    const na = await Promise.all(Array.from({ length: 10 }, () => isMedewerker(sessie.token)));
    const ververst = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: anonKey, "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: verversing }),
    });
    expect(na.some(Boolean) || ververst.ok).toBe(false);
  });

  it("3.2 MISLUKT: klok en tijdzone: na twaalf uur komt het recht terug door de tijdzone van het verzoek te kiezen of parallel te verversen", async () => {
    const { sessie } = await medewerker("tijdzone");
    zetSessieBegin(sessie.sessieId, 12.5);
    const pogingen = await Promise.all([
      isMedewerker(sessie.token, { Prefer: "timezone=Pacific/Kiritimati" }),
      isMedewerker(sessie.token, { Prefer: "timezone=Etc/GMT+12" }),
      isMedewerker(sessie.token, { Prefer: "timezone=America/Los_Angeles" }),
    ]);
    const ververst = await Promise.all(
      Array.from({ length: 5 }, () => sessie.client.auth.refreshSession()),
    );
    const tokens = ververst.flatMap((v) => v.data.session?.access_token ?? []);
    const naVerversen = await Promise.all(tokens.map((token) => isMedewerker(token)));
    expect(tokens.length).toBeGreaterThan(0);
    expect([...pogingen, ...naVerversen].some(Boolean)).toBe(false);
  });

  it("3.3 MISLUKT: omdopen: een mailsessie op het account van een medewerker zet zelf `amr`, de inlogdienst of een koppeling via de API van Supabase", async () => {
    const { persoon } = await medewerker("omdopen");
    const perMail = await inloggenMetMailcode(persoon.email);
    const auth = { apikey: anonKey, Authorization: `Bearer ${perMail.token}` };
    await fetch(`${url}/auth/v1/user`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        data: { amr: [{ method: "oauth" }], provider: "custom:cloudflare" },
        app_metadata: { provider: "custom:cloudflare", providers: ["custom:cloudflare"] },
        amr: [{ method: "oauth", timestamp: Math.floor(Date.now() / 1000) }],
      }),
    });
    // Een koppeling beginnen of weghalen: de inrichting en config.toml zetten dat dicht.
    const koppelen = await fetch(
      `${url}/auth/v1/user/identities/authorize?provider=keycloak&skip_http_redirect=true`,
      { headers: auth },
    );
    const idToken = await fetch(`${url}/auth/v1/token?grant_type=id_token`, {
      method: "POST",
      headers: { apikey: anonKey, "content-type": "application/json" },
      body: JSON.stringify({ provider: "keycloak", id_token: perMail.token }),
    });
    const { data: ververst } = await perMail.client.auth.refreshSession();
    const tokens = [perMail.token, ververst.session?.access_token ?? perMail.token];
    const rechten = await Promise.all(tokens.map((token) => isMedewerker(token)));
    expect(perMail.userId).toBe((await accountsVan(persoon))[0]);
    expect(rechten.some(Boolean) || koppelen.ok || idToken.ok).toBe(false);
  });

  it("3.4 GELUKT ALS: een medewerker die in Supabase is geblokkeerd (ban) houdt met zijn lopende token medewerkerrechten", async () => {
    const { sessie } = await medewerker("ban");
    const { error } = await admin.auth.admin.updateUserById(sessie.userId, {
      ban_duration: "24h",
    });
    expect(error).toBeNull();
    await pauze(500);
    expect(await isMedewerker(sessie.token)).toBe(true);
    const { data } = await metToken(sessie.token).from("klanten").select("user_id").limit(1);
    expect(data).not.toBeNull();
  });
});

describe("AANVAL2 doel 4: een klant die meer kan dan mag", () => {
  it("4.1 MISLUKT: een adres dat op dat van een bekende klant lijkt (aanhalingstekens of een Cyrillische letter) komt zo op de lijst van de medewerker", async () => {
    const staart = Math.random().toString(36).slice(2, 8);
    const adressen = [
      `"directie@groteklant.nl"@a2${staart}.voorbeeld.nl`,
      // De e in directie is hier de Cyrillische е (U+0435).
      `dirеctie-${staart}@voorbeeld.nl`,
    ];
    const opDeLijst: string[] = [];
    const geweigerd: string[] = [];
    for (const adres of adressen) {
      try {
        const sessie = await inloggenMetMailcode(adres);
        opruimen.add(sessie.userId);
        await sessie.client.rpc("klant_aanmelden");
        const { data } = await admin.from("klanten").select("e_mail").eq("user_id", sessie.userId);
        if (data?.[0]) opDeLijst.push(data[0].e_mail);
      } catch (fout) {
        // Supabase of de mail weigerde dit adres.
        geweigerd.push(String(fout).slice(0, 120));
      }
    }
    expect(geweigerd).toHaveLength(adressen.length);
    expect(opDeLijst).toEqual([]);
  }, 90_000);

  it("4.2 GELUKT ALS: massaal aanmelden: zes verse adressen zijn zes regels op de lijst van de medewerker, zonder rem in de app", async () => {
    const ids: string[] = [];
    for (let nummer = 0; nummer < 6; nummer += 1) {
      const sessie = await klant(`massaal-${nummer}`, { goedgekeurd: false });
      ids.push(sessie.userId);
    }
    const { data } = await admin.from("klanten").select("user_id").in("user_id", ids);
    expect(data).toHaveLength(6);
  }, 90_000);

  it("4.3 MISLUKT: de trigger misbruiken: een vreemde laat een goedgekeurde klant zijn goedkeuring of zijn sessie verliezen", async () => {
    const slachtoffer = await klant("slachtoffer", { goedgekeurd: true });
    const { data: account } = await admin.auth.admin.getUserById(slachtoffer.userId);
    const adres = account.user?.email ?? "";
    const vreemde = await klant("vreemde", { goedgekeurd: false });
    await vreemde.client.auth.updateUser({ email: adres });
    await vreemde.client.auth.updateUser({ email: adres.toUpperCase() });
    await vreemde.client.auth.updateUser({ email: ` ${adres} ` });
    await createClient(url, anonKey).auth.signInWithOtp({ email: adres });
    await createClient(url, anonKey).auth.resetPasswordForEmail(adres);
    await pauze(1000);
    const { data: regel } = await admin
      .from("klanten")
      .select("goedgekeurd, e_mail")
      .eq("user_id", slachtoffer.userId);
    const { data: nog } = await metToken(slachtoffer.token).rpc("is_goedgekeurde_klant");
    expect(regel?.[0]?.goedgekeurd !== true || nog !== true).toBe(false);
  });

  it("4.4 GELUKT ALS: een klant die in Supabase is geblokkeerd (ban) blijft met zijn lopende token goedgekeurd", async () => {
    const sessie = await klant("ban", { goedgekeurd: true });
    const { error } = await admin.auth.admin.updateUserById(sessie.userId, {
      ban_duration: "24h",
    });
    expect(error).toBeNull();
    await pauze(500);
    const { data } = await metToken(sessie.token).rpc("is_goedgekeurde_klant");
    expect(data).toBe(true);
  });
});
