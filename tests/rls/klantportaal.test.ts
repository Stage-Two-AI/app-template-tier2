import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Actor,
  admin,
  anoniem,
  controleerAfscherming,
  maakActor,
  verwijderActor,
} from "./lib/afscherming";
import { type NepInlogdienst, type Persoon, startNepInlogdienst } from "./lib/inlogdienst-nep";
import {
  accountsVan,
  inloggenMetCode,
  inloggenMetMailcode,
  inloggenViaInlogdienst,
  leesToken,
  metToken,
  nieuwAdres,
  nieuwPersoon,
  noemIdentiteitCloudflare,
  type Sessie,
  sessieViaInlogdienst,
  type ViaInlogdienst,
  verwijderAccount,
  wachtOpMail,
  zetSessieBegin,
} from "./lib/sessies";

/**
 * Het klantportaal: medewerkers en klanten in dezelfde app, zonder deur ervoor.
 *
 * De regel (docs/WERKWIJZE.md): een recht hangt nooit aan iets wat een klant zelf kan
 * claimen. Medewerkerrechten zijn er alleen in een sessie die via Cloudflare begon. Wie per
 * mail inlogt op het adres van een medewerker, komt op hetzelfde account uit (Supabase kent
 * één account per adres) en is toch gewoon klant.
 *
 * Alles hier logt echt in bij de lokale Supabase Auth: per mail met de code uit de lokale
 * mailvanger, en via een inlogdienst tegen een nagebootste dienst die de test zelf start.
 * Elk token is door Supabase gemaakt en ondertekend. Wat lokaal niet echt kan (de naam
 * `custom:cloudflare`) en wat dat betekent, staat in tests/rls/lib/sessies.ts.
 */
let dienst: NepInlogdienst;
/** Een medewerker zoals Cloudflare hem doorgeeft: zonder "dit adres is gecontroleerd". */
let medewerker: Persoon;
let eersteKeer: ViaInlogdienst;
let naBevestigen: Sessie;
let viaCloudflare: Sessie;
let perMail: Sessie;
let klant: Sessie;
const opruimen = new Set<string>();

beforeAll(async () => {
  dienst = await startNepInlogdienst();

  // Een nieuwe medewerker logt voor het eerst in via de inlogdienst. Supabase kent het adres
  // nog niet en de dienst zegt er niet bij dat het gecontroleerd is (net als Cloudflare):
  // Supabase maakt het account, weigert de inlog en stuurt een mail om het adres te bevestigen.
  medewerker = nieuwPersoon("medewerker", { adresBevestigd: false });
  const leesMail = await wachtOpMail(medewerker.email);
  eersteKeer = await inloggenViaInlogdienst(medewerker);
  for (const id of await accountsVan(medewerker)) opruimen.add(id);
  // De medewerker bevestigt zijn adres met de code uit die mail. Dat is inloggen per mail.
  naBevestigen = await inloggenMetCode(medewerker.email, (await leesMail()).code);
  // Daarna werkt de inlogdienst: dit is de sessie "via Cloudflare".
  viaCloudflare = await sessieViaInlogdienst(medewerker);
  noemIdentiteitCloudflare(viaCloudflare.userId);

  // Iemand met toegang tot de mailbox van de medewerker vraagt een code aan op dat adres.
  perMail = await inloggenMetMailcode(medewerker.email);

  // Een nieuwe klant: het adres bestaat nog niet, inloggen per mail maakt het account.
  klant = await inloggenMetMailcode(nieuwAdres("klant"));
  opruimen.add(klant.userId);
  const { error } = await klant.client.rpc("klant_aanmelden");
  if (error) throw new Error(`De klant kon zich niet aanmelden: ${error.message}`);
}, 60_000);

afterAll(async () => {
  for (const id of opruimen) await verwijderAccount(id);
  await dienst?.stop();
});

async function isMedewerker(sessie: Pick<Sessie, "client">): Promise<boolean | null> {
  const { data, error } = await sessie.client.rpc("is_medewerker");
  if (error) throw new Error(`is_medewerker gaf een fout: ${error.message}`);
  return data;
}

/** Een persoon met een eigen account, ingelogd via de inlogdienst; ruimt zichzelf op. */
async function metAccountViaDienst(
  label: string,
  doe: (sessie: Sessie, persoon: Persoon) => Promise<void>,
): Promise<void> {
  const persoon = nieuwPersoon(label, { adresBevestigd: true });
  try {
    await doe(await sessieViaInlogdienst(persoon), persoon);
  } finally {
    for (const id of await accountsVan(persoon)) await verwijderAccount(id);
  }
}

describe("waar de controle op vertrouwt: wat Supabase in het token zet", () => {
  it("een nieuwe medewerker moet zijn adres eerst bevestigen, en dat is inloggen per mail", () => {
    // Zo gaat het in productie ook; de inlogpagina vertaalt deze weigering (mailcode.ts).
    expect(eersteKeer).toMatchObject({ ok: false, code: "provider_email_needs_verification" });
    expect(eersteKeer.ok ? "" : eersteKeer.tekst).toContain("Unverified email");
    expect(naBevestigen.methodes).toEqual(["otp"]);
  });

  it("een mailsessie op het adres van een medewerker is hetzelfde account", () => {
    // Dit is de valkuil: wie op auth.uid() of het e-mailadres vertrouwt, ziet geen verschil.
    expect(perMail.userId).toBe(viaCloudflare.userId);
    expect(naBevestigen.userId).toBe(viaCloudflare.userId);
    expect(leesToken(perMail.token).email).toBe(medewerker.email);
    expect(leesToken(viaCloudflare.token).email).toBe(medewerker.email);
    expect(perMail.sessieId).not.toBe(viaCloudflare.sessieId);
  });

  it("het token zegt hoe de sessie begon: per mail is nooit oauth, via de dienst altijd", () => {
    // Supabase schrijft dit zelf, bij het begin van de sessie. De test heeft er niets aan gedaan.
    expect(perMail.methodes).toEqual(["otp"]);
    expect(naBevestigen.methodes).not.toContain("oauth");
    expect(klant.methodes).not.toContain("oauth");
    expect(viaCloudflare.methodes).toEqual(["oauth"]);
  });

  it("app_metadata zegt het niet: daar staat de inlogdienst ook bij een mailsessie", async () => {
    // providers is de lijst van alles wat aan het account hangt, niet hoe deze sessie begon.
    // Ook in het token van de mailsessie staat dus Cloudflare. Wie daarop vertrouwt, geeft
    // iedereen met toegang tot de mailbox van een medewerker de rechten van die medewerker.
    const inToken = leesToken(perMail.token).app_metadata as { providers?: string[] };
    expect(inToken.providers).toContain("custom:cloudflare");
    const { data } = await admin.auth.admin.getUserById(viaCloudflare.userId);
    const aanHetAccount = data.user?.identities?.map((i) => i.provider) ?? [];
    expect(aanHetAccount).toContain("custom:cloudflare");
    expect(await isMedewerker(perMail)).toBe(false);
  });
});

describe("medewerkerrechten alleen in een sessie via Cloudflare", () => {
  it("dezelfde persoon via Cloudflare is medewerker", async () => {
    expect(await isMedewerker(viaCloudflare)).toBe(true);
    const { data } = await viaCloudflare.client.rpc("sessie_via_cloudflare");
    expect(data).toBe(true);
  });

  it("een mailsessie op het adres van een medewerker is geen medewerker", async () => {
    expect(await isMedewerker(perMail)).toBe(false);
    const { data } = await perMail.client.rpc("sessie_via_cloudflare");
    expect(data).toBe(false);
  });

  it("ook de mailsessie waarmee de medewerker zijn adres bevestigde is geen medewerker", async () => {
    expect(await isMedewerker(naBevestigen)).toBe(false);
  });

  it("ook de code uit een herstelmail geeft alleen een mailsessie, zonder medewerkerrechten", async () => {
    // Iedereen kan voor elk adres een herstelmail laten sturen (/recover). Die mail is
    // dezelfde als de inlogmail, en de code eruit werkt in hetzelfde codevak.
    const leesMail = await wachtOpMail(medewerker.email);
    let aanvraag = await anoniem().auth.resetPasswordForEmail(medewerker.email);
    if (aanvraag.error?.status === 429) {
      // Supabase stuurt per adres niet vaker dan eens per seconde.
      await new Promise((klaar) => setTimeout(klaar, 1500));
      aanvraag = await anoniem().auth.resetPasswordForEmail(medewerker.email);
    }
    expect(aanvraag.error).toBeNull();
    const sessie = await inloggenMetCode(medewerker.email, (await leesMail()).code);
    expect(sessie.userId).toBe(viaCloudflare.userId);
    expect(sessie.methodes).not.toContain("oauth");
    expect(await isMedewerker(sessie)).toBe(false);
  });

  it("een klant is geen medewerker, en een bezoeker zonder inlog mag het niet eens vragen", async () => {
    expect(await isMedewerker(klant)).toBe(false);
    const { data, error } = await anoniem().rpc("is_medewerker");
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it("blijft na verversen van het token: per mail nee, via Cloudflare ja", async () => {
    const mail = await perMail.client.auth.refreshSession();
    expect(mail.error).toBeNull();
    expect(leesToken(mail.data.session?.access_token ?? "").amr).toEqual([
      expect.objectContaining({ method: "otp" }),
    ]);
    expect(await isMedewerker(perMail)).toBe(false);

    const cloudflare = await viaCloudflare.client.auth.refreshSession();
    expect(cloudflare.error).toBeNull();
    expect(leesToken(cloudflare.data.session?.access_token ?? "").amr).toEqual([
      expect.objectContaining({ method: "oauth" }),
    ]);
    expect(await isMedewerker(viaCloudflare)).toBe(true);
  });

  it("zelf iets in user_metadata zetten helpt niet", async () => {
    // user_metadata past iedere gebruiker zelf aan; het komt in het token, maar telt niet.
    const { error } = await perMail.client.auth.updateUser({
      data: {
        amr: [{ method: "oauth" }],
        provider: "custom:cloudflare",
        providers: ["custom:cloudflare"],
        rol: "medewerker",
        is_medewerker: true,
      },
    });
    expect(error).toBeNull();
    await perMail.client.auth.refreshSession();
    const { data } = await perMail.client.auth.getSession();
    const inhoud = leesToken(data.session?.access_token ?? "");
    expect(inhoud.user_metadata).toMatchObject({ rol: "medewerker" });
    expect(inhoud.amr).toEqual([expect.objectContaining({ method: "otp" })]);
    expect(await isMedewerker(perMail)).toBe(false);
  });

  it("een account met wachtwoord en een Cloudflare-identiteit is met dat wachtwoord geen medewerker", async () => {
    let actor: Actor | undefined;
    try {
      actor = await maakActor("wachtwoord");
      // De dienst zegt hier wel dat het adres gecontroleerd is; Supabase hangt de inlog dan
      // aan het bestaande account met dat adres.
      const viaDienst = await sessieViaInlogdienst({
        sub: `dienst-${actor.id}`,
        email: actor.email,
        email_verified: true,
      });
      expect(viaDienst.userId).toBe(actor.id);
      noemIdentiteitCloudflare(actor.id);
      expect(await isMedewerker(viaDienst)).toBe(true);
      expect(await isMedewerker(actor)).toBe(false);
    } finally {
      await verwijderActor(actor);
    }
  });

  it("hangt er een tweede inlogdienst aan het account, dan zegt de functie nee", async () => {
    // amr zegt "via een inlogdienst", niet welke. Met twee diensten is niet meer te zeggen
    // dat het Cloudflare was, en dan is het antwoord nee, ook in de sessie die al liep.
    await metAccountViaDienst("twee-diensten", async (eerste, persoon) => {
      noemIdentiteitCloudflare(eerste.userId);
      expect(await isMedewerker(eerste)).toBe(true);
      // Dezelfde persoon logt nu in via een dienst die bij Supabase anders heet: de lokale
      // dienst onder zijn eigen naam. Supabase hangt hem aan hetzelfde account.
      const tweede = await sessieViaInlogdienst(persoon);
      expect(tweede.userId).toBe(eerste.userId);
      expect(tweede.methodes).toEqual(["oauth"]);
      expect(await isMedewerker(tweede)).toBe(false);
      expect(await isMedewerker(eerste)).toBe(false);
    });
  });

  it("via een andere inlogdienst dan Cloudflare is ook een oauth-sessie geen medewerker", async () => {
    await metAccountViaDienst("zonder-cloudflare", async (sessie) => {
      expect(sessie.methodes).toEqual(["oauth"]);
      expect(await isMedewerker(sessie)).toBe(false);
    });
  });

  it("een inlog via Cloudflare geeft twaalf uur medewerkerrechten, en verversen verlengt dat niet", async () => {
    await metAccountViaDienst("twaalf-uur", async (sessie) => {
      noemIdentiteitCloudflare(sessie.userId);
      expect(await isMedewerker(sessie)).toBe(true);

      zetSessieBegin(sessie.sessieId, 11.5);
      expect(await isMedewerker(sessie)).toBe(true);

      zetSessieBegin(sessie.sessieId, 12.5);
      expect(await isMedewerker(sessie)).toBe(false);
      // De sessie zelf leeft nog en het token is te verversen, maar het recht komt niet terug.
      const ververst = await sessie.client.auth.refreshSession();
      expect(ververst.error).toBeNull();
      expect(leesToken(ververst.data.session?.access_token ?? "").amr).toEqual([
        expect.objectContaining({ method: "oauth" }),
      ]);
      expect(await isMedewerker(sessie)).toBe(false);
      const { data } = await sessie.client.auth.getUser();
      expect(data.user?.id).toBe(sessie.userId);

      // Terug naar een verse sessie: het lag aan de tijd, niet aan iets anders.
      zetSessieBegin(sessie.sessieId, 0);
      expect(await isMedewerker(sessie)).toBe(true);
    });
  });

  it("na uitloggen is het recht meteen weg, ook met het oude token", async () => {
    await metAccountViaDienst("uitgelogd", async (sessie) => {
      noemIdentiteitCloudflare(sessie.userId);
      const oudToken = sessie.token;
      expect(await isMedewerker({ client: metToken(oudToken) })).toBe(true);
      await sessie.client.auth.signOut({ scope: "local" });
      expect(await isMedewerker({ client: metToken(oudToken) })).toBe(false);
    });
  });
});

describe("klanten: zonder rechten tot een medewerker goedkeurt", () => {
  it("de A/B-test: klant B ziet, wijzigt en verwijdert de regel van klant A niet", async () => {
    await controleerAfscherming({
      tabel: "klanten",
      sleutel: "user_id",
      maakRijAlsA: async (a) => {
        const { error } = await a.client.rpc("klant_aanmelden");
        if (error) throw new Error(`A kon zich niet aanmelden: ${error.message}`);
        return a.id;
      },
    });
  });

  it("een nieuwe klant ziet alleen zijn eigen regel en is niet goedgekeurd", async () => {
    const { data, error } = await klant.client.from("klanten").select("user_id, goedgekeurd");
    expect(error).toBeNull();
    expect(data).toEqual([{ user_id: klant.userId, goedgekeurd: false }]);
    const { data: goedgekeurd } = await klant.client.rpc("is_goedgekeurde_klant");
    expect(goedgekeurd).toBe(false);
  });

  it("het adres komt uit het account, niet uit wat de klant meestuurt", async () => {
    const { data } = await admin.from("klanten").select("e_mail").eq("user_id", klant.userId);
    expect(data?.[0]?.e_mail).toBe(leesToken(klant.token).email);
    const { error } = await klant.client
      .from("klanten")
      .insert({ user_id: klant.userId, e_mail: "iemand@anders.nl", goedgekeurd: true });
    expect(error).not.toBeNull();
  });

  it("een klant kan zichzelf niet goedkeuren", async () => {
    const poging = await klant.client
      .from("klanten")
      .update({ goedgekeurd: true })
      .eq("user_id", klant.userId)
      .select("user_id");
    expect(poging.data ?? []).toEqual([]);
    const { data } = await admin.from("klanten").select("goedgekeurd").eq("user_id", klant.userId);
    expect(data).toEqual([{ goedgekeurd: false }]);
  });

  it("een mailsessie op het adres van een medewerker ziet de klant niet en keurt niet goed", async () => {
    const zien = await perMail.client.from("klanten").select("user_id").eq("user_id", klant.userId);
    expect(zien.data).toEqual([]);
    const poging = await perMail.client
      .from("klanten")
      .update({ goedgekeurd: true })
      .eq("user_id", klant.userId)
      .select("user_id");
    expect(poging.data ?? []).toEqual([]);
    const { data } = await admin.from("klanten").select("goedgekeurd").eq("user_id", klant.userId);
    expect(data).toEqual([{ goedgekeurd: false }]);
  });

  it("dezelfde medewerker via Cloudflare ziet de klant en keurt hem goed", async () => {
    const zien = await viaCloudflare.client
      .from("klanten")
      .select("user_id")
      .eq("user_id", klant.userId);
    expect(zien.data).toEqual([{ user_id: klant.userId }]);
    const goedkeuren = await viaCloudflare.client
      .from("klanten")
      .update({ goedgekeurd: true })
      .eq("user_id", klant.userId)
      .select("user_id");
    expect(goedkeuren.error).toBeNull();
    expect(goedkeuren.data).toEqual([{ user_id: klant.userId }]);
    const { data } = await klant.client.rpc("is_goedgekeurde_klant");
    expect(data).toBe(true);
  });

  it("ook een medewerker wijzigt alleen de goedkeuring, niet het adres", async () => {
    const { error } = await viaCloudflare.client
      .from("klanten")
      .update({ e_mail: "ander@adres.nl" })
      .eq("user_id", klant.userId);
    expect(error?.code).toBe("42501");
  });
});
