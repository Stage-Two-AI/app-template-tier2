import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { linksUit } from "../lib/mailvanger";
import {
  type Actor,
  admin,
  anoniem,
  controleerAfscherming,
  maakActor,
  verwijderActor,
} from "./lib/afscherming";
import { vraagDatabase } from "./lib/database";
import { type NepInlogdienst, type Persoon, startNepInlogdienst } from "./lib/inlogdienst-nep";
import { problemenKlantportaalInDatabase } from "./lib/klantportaal-poort";
import {
  accountsVan,
  hangSessieAanAccount,
  inloggenMetCode,
  inloggenMetMailcode,
  inloggenViaInlogdienst,
  leesToken,
  maakKoppelingEmail,
  metPoortOp,
  metToken,
  nieuwAdres,
  nieuwPersoon,
  noemIdentiteitCloudflare,
  pauze,
  type Sessie,
  sessieViaInlogdienst,
  type ViaInlogdienst,
  verwijderAccount,
  voegKoppelingToe,
  wachtOpElkeMail,
  wachtOpMail,
  zetAdresLeeg,
  zetSessieBegin,
} from "./lib/sessies";

const url = String(import.meta.env.SUPABASE_URL);
const anonKey = String(import.meta.env.SUPABASE_ANON_KEY);

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

/** Een verse klant met een eigen account, per mail ingelogd; wordt aan het eind opgeruimd. */
async function nieuweKlant(label: string): Promise<Sessie> {
  const sessie = await inloggenMetMailcode(nieuwAdres(label));
  opruimen.add(sessie.userId);
  return sessie;
}

async function regelVan(userId: string) {
  const { data, error } = await admin
    .from("klanten")
    .select("e_mail, goedgekeurd")
    .eq("user_id", userId);
  if (error) throw new Error(`Kon de klantenlijst niet nakijken: ${error.message}`);
  return data[0];
}

async function keurGoed(userId: string): Promise<void> {
  const { error } = await admin.from("klanten").update({ goedgekeurd: true }).eq("user_id", userId);
  if (error) throw new Error(`Goedkeuren als beheerder mislukt: ${error.message}`);
}

async function isGoedgekeurd(sessie: Pick<Sessie, "client">): Promise<boolean | null> {
  const { data, error } = await sessie.client.rpc("is_goedgekeurde_klant");
  if (error) throw new Error(`is_goedgekeurde_klant gaf een fout: ${error.message}`);
  return data;
}

function b64(waarde: unknown): string {
  return Buffer.from(JSON.stringify(waarde)).toString("base64url");
}

/**
 * Een klant wijzigt zelf het adres van zijn account, zoals Supabase dat toelaat als de
 * inrichting het niet dichtzet: beide adressen krijgen een mail en beide links worden
 * aangeklikt. Daarna staat het nieuwe adres op het account.
 */
async function wijzigAdres(sessie: Sessie, van: string, naar: string): Promise<void> {
  const naarOud = await wachtOpElkeMail(van);
  const naarNieuw = await wachtOpElkeMail(naar);
  // Supabase stuurt per adres niet vaker dan eens per seconde.
  await pauze(1200);
  const { error } = await sessie.client.auth.updateUser({ email: naar });
  if (error) throw new Error(`De adreswijziging aanvragen mislukte: ${error.message}`);
  for (const lees of [naarOud, naarNieuw]) {
    const link = linksUit((await lees(8000)) ?? "").find((href) =>
      href.includes("/auth/v1/verify"),
    );
    if (link) await fetch(link, { redirect: "manual" });
  }
  const { data } = await admin.auth.admin.getUserById(sessie.userId);
  if (data.user?.email !== naar) {
    throw new Error("De opzet klopt niet: het adres van het account is niet gewijzigd.");
  }
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

  it("een klant is geen medewerker", async () => {
    expect(await isMedewerker(klant)).toBe(false);
  });

  it("een bezoeker zonder inlog mag geen van de vier functies aanroepen", async () => {
    for (const functie of [
      "sessie_via_cloudflare",
      "is_medewerker",
      "klant_aanmelden",
      "is_goedgekeurde_klant",
    ] as const) {
      const { data, error } = await anoniem().rpc(functie);
      expect(error, `${functie} is aan te roepen zonder inlog`).not.toBeNull();
      expect(data, functie).toBeNull();
    }
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

      zetSessieBegin(sessie.sessieId, 12.1);
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

  it("ook als een andere sessie op het account iedereen uitlogt, is het oude token niets meer waard", async () => {
    await metAccountViaDienst("uitgelogd-door-ander", async (sessie, persoon) => {
      noemIdentiteitCloudflare(sessie.userId);
      const mail = await inloggenMetMailcode(persoon.email);
      await mail.client.auth.signOut({ scope: "others" });
      expect(await isMedewerker({ client: metToken(sessie.token) })).toBe(false);
    });
  });

  it("de twaalf uur tellen voor de sessie van dit token, niet voor een andere sessie op het account", async () => {
    // Dezelfde medewerker logt twee keer in via Cloudflare. De oude sessie is over de tijd;
    // dat er op het account ook een verse sessie loopt, geeft het oude token niets terug.
    const persoon = nieuwPersoon("twee-sessies", { adresBevestigd: true });
    try {
      const oud = await sessieViaInlogdienst(persoon);
      const vers = await sessieViaInlogdienst(persoon);
      expect(vers.userId).toBe(oud.userId);
      expect(vers.sessieId).not.toBe(oud.sessieId);
      noemIdentiteitCloudflare(oud.userId);
      expect(await isMedewerker(oud)).toBe(true);
      zetSessieBegin(oud.sessieId, 13);
      expect(await isMedewerker(oud)).toBe(false);
      expect(await isMedewerker(vers)).toBe(true);
    } finally {
      for (const id of await accountsVan(persoon)) await verwijderAccount(id);
    }
  });

  it("de sessie moet van het account zelf zijn: een sessie die bij een ander account hoort, telt niet", async () => {
    await metAccountViaDienst("sessie-van-ander", async (eerste) => {
      noemIdentiteitCloudflare(eerste.userId);
      await metAccountViaDienst("sessie-ontvanger", async (tweede) => {
        noemIdentiteitCloudflare(tweede.userId);
        expect(await isMedewerker(eerste)).toBe(true);
        // In de administratie van Supabase hoort de sessie nu bij het andere account. Het
        // token van het eerste account wijst er nog naar.
        hangSessieAanAccount(eerste.sessieId, tweede.userId);
        expect(await isMedewerker({ client: metToken(eerste.token) })).toBe(false);
      });
    });
  });

  it("zonder koppeling met Cloudflare is ook een sessie via een inlogdienst geen medewerker", async () => {
    // De sessie begon via een inlogdienst (oauth), maar aan het account hangt daarna alleen
    // nog een e-mailkoppeling. Dat er geen ándere dienst aan hangt is niet genoeg: de
    // koppeling met Cloudflare moet er zijn.
    await metAccountViaDienst("zonder-koppeling", async (sessie) => {
      maakKoppelingEmail(sessie.userId);
      expect(sessie.methodes).toEqual(["oauth"]);
      expect(await isMedewerker(sessie)).toBe(false);
    });
  });

  it("een wachtwoord dat de mailsessie zelf op het account zet, geeft geen medewerkerrechten", async () => {
    await metAccountViaDienst("eigen-wachtwoord", async (viaDienst, persoon) => {
      noemIdentiteitCloudflare(viaDienst.userId);
      const mail = await inloggenMetMailcode(persoon.email);
      const wachtwoord = `Zelf-gezet-${Date.now()}`;
      await mail.client.auth.updateUser({ password: wachtwoord });
      const client = createClient(url, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const inlog = await client.auth.signInWithPassword({
        email: persoon.email,
        password: wachtwoord,
      });
      // Lukt het inloggen (lokaal mag een wachtwoord), dan is het nog steeds geen medewerker.
      if (!inlog.error) expect(await isMedewerker({ client })).toBe(false);
      expect(await isMedewerker(mail)).toBe(false);
    });
  });

  it("een zelfgemaakt of aangepast token wordt niet aangenomen", async () => {
    const inhoud = {
      ...leesToken(perMail.token),
      amr: [{ method: "oauth", timestamp: Math.floor(Date.now() / 1000) }],
      session_id: viaCloudflare.sessieId,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const [kop, , handtekening] = perMail.token.split(".");
    const zelfOndertekend = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(inhoud)}`;
    const pogingen = [
      // Het mailtoken met een andere inhoud en de oude handtekening.
      `${kop}.${b64(inhoud)}.${handtekening}`,
      // Zonder handtekening.
      `${b64({ alg: "none", typ: "JWT" })}.${b64(inhoud)}.`,
      // Ondertekend met de openbare sleutel van de app als geheim.
      `${zelfOndertekend}.${createHmac("sha256", anonKey).update(zelfOndertekend).digest("base64url")}`,
    ];
    for (const token of pogingen) {
      const { data, error } = await metToken(token).rpc("is_medewerker");
      expect(error).not.toBeNull();
      expect(data).toBeNull();
    }
  });

  it("de administratie van Supabase zelf (sessies, koppelingen) is via de API niet te lezen", async () => {
    for (const schema of ["auth", "public"]) {
      for (const tabel of ["sessions", "identities", "mfa_amr_claims"]) {
        const antwoord = await fetch(`${url}/rest/v1/${tabel}?select=*&limit=1`, {
          headers: {
            apikey: anonKey,
            Authorization: `Bearer ${perMail.token}`,
            "Accept-Profile": schema,
          },
        });
        expect(antwoord.status, `${schema}.${tabel}`).not.toBe(200);
      }
    }
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

  it("een nieuwe klant staat op de lijst, is niet goedgekeurd en ziet de lijst zelf niet", async () => {
    expect(await regelVan(klant.userId)).toMatchObject({ goedgekeurd: false });
    expect(await isGoedgekeurd(klant)).toBe(false);
    // Ook zijn eigen regel niet: of hij is goedgekeurd, hoort hij van is_goedgekeurde_klant().
    const { data, error } = await klant.client.from("klanten").select("user_id");
    expect(error).toBeNull();
    expect(data).toEqual([]);
    const telling = await klant.client.from("klanten").select("*", { count: "exact", head: true });
    expect(telling.count ?? 0).toBe(0);
  });

  it("wie zich niet heeft aangemeld, kan zelf geen regel maken, ook geen goedgekeurde", async () => {
    // Een verse klant zonder regel: hier kan de poging niet stuklopen op "bestaat al".
    const vers = await nieuweKlant("zelf-regel");
    const poging = await vers.client
      .from("klanten")
      .insert({ user_id: vers.userId, e_mail: "iemand@anders.nl", goedgekeurd: true });
    expect(poging.error).not.toBeNull();
    await vers.client
      .from("klanten")
      .upsert({ user_id: vers.userId, e_mail: "iemand@anders.nl", goedgekeurd: true });
    expect(await regelVan(vers.userId)).toBeUndefined();
    expect(await isGoedgekeurd(vers)).toBe(false);
  });

  it("het adres komt uit het account: niet uit user_metadata en niet uit wat de klant meestuurt", async () => {
    const vers = await nieuweKlant("adres-uit-account");
    const echt = String(leesToken(vers.token).email);
    // user_metadata vult een gebruiker zelf; het staat daarna in zijn token.
    const gezet = await vers.client.auth.updateUser({
      data: { e_mail: "directie@bedrijf.nl", email: "directie@bedrijf.nl" },
    });
    expect(gezet.error).toBeNull();
    await vers.client.auth.refreshSession();
    const { data } = await vers.client.auth.getSession();
    expect(leesToken(data.session?.access_token ?? "").user_metadata).toMatchObject({
      e_mail: "directie@bedrijf.nl",
    });
    // Argumenten kent de functie niet; zo'n aanroep doet niets.
    await vers.client.rpc("klant_aanmelden", { e_mail: "directie@bedrijf.nl" } as never);
    await vers.client.rpc("klant_aanmelden", { user_id: klant.userId, goedgekeurd: true } as never);
    const aanmelden = await vers.client.rpc("klant_aanmelden");
    expect(aanmelden.error).toBeNull();
    expect(await regelVan(vers.userId)).toEqual({ e_mail: echt, goedgekeurd: false });
  });

  it("een klant kan zichzelf niet goedkeuren: niet via de tabel, niet via alle rijen tegelijk, niet via GraphQL", async () => {
    const poging = await klant.client
      .from("klanten")
      .update({ goedgekeurd: true })
      .eq("user_id", klant.userId)
      .select("user_id");
    expect(poging.data ?? []).toEqual([]);
    await klant.client.from("klanten").update({ goedgekeurd: true }).neq("e_mail", "");
    await klant.client
      .from("klanten")
      .upsert({ user_id: klant.userId, e_mail: "x@y.nl", goedgekeurd: true });
    await fetch(`${url}/graphql/v1`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${klant.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query:
          "mutation { updateklantenCollection(set: {goedgekeurd: true}, atMost: 100) { affectedCount } }",
      }),
    });
    expect(await regelVan(klant.userId)).toMatchObject({ goedgekeurd: false });
  });

  it("een klant wijzigt geen adres of datum en haalt geen regel weg, ook zijn eigen niet", async () => {
    const voor = await regelVan(klant.userId);
    const eigen = klant.client.from("klanten");
    await eigen.update({ e_mail: "directie@bedrijf.nl" }).eq("user_id", klant.userId);
    await klant.client
      .from("klanten")
      .update({ aangemeld_op: "2000-01-01" })
      .eq("user_id", klant.userId);
    await klant.client.from("klanten").delete().eq("user_id", klant.userId);
    expect(await regelVan(klant.userId)).toEqual(voor);
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
    expect(await regelVan(klant.userId)).toMatchObject({ goedgekeurd: false });
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
    expect(await isGoedgekeurd(klant)).toBe(true);
  });

  it("ook een medewerker wijzigt alleen de goedkeuring, niet het adres", async () => {
    const { error } = await viaCloudflare.client
      .from("klanten")
      .update({ e_mail: "ander@adres.nl" })
      .eq("user_id", klant.userId);
    expect(error?.code).toBe("42501");
  });

  it("na uitloggen is ook de goedkeuring niets meer waard met het oude token", async () => {
    const vers = await nieuweKlant("uitgelogde-klant");
    await vers.client.rpc("klant_aanmelden");
    await keurGoed(vers.userId);
    expect(await isGoedgekeurd({ client: metToken(vers.token) })).toBe(true);
    await vers.client.auth.signOut({ scope: "local" });
    expect(await isGoedgekeurd({ client: metToken(vers.token) })).toBe(false);
  });
});

describe("de poort van een klantportaal: wie alleen een mailadres heeft, mag niets", () => {
  // De template zelf is geen klantportaal; de voorbeeldtabel `items` heeft de poort dus niet.
  // Met `"klantportaal": true` eist `pnpm guard:rls` de poort op elke tabel. Deze test zet
  // hem voor even op `items` en bewijst wat die ene regel doet (docs/WERKWIJZE.md).
  it("zonder goedkeuring leest en schrijft een account niets; na goedkeuring wel, en alleen het eigen", async () => {
    const vreemde = await nieuweKlant("vreemde");
    const goedgekeurd = await nieuweKlant("goedgekeurd");
    await goedgekeurd.client.rpc("klant_aanmelden");
    await keurGoed(goedgekeurd.userId);

    await metPoortOp("items", async () => {
      const schrijven = await vreemde.client
        .from("items")
        .insert({ owner_id: vreemde.userId, title: "van een vreemde" });
      expect(schrijven.error).not.toBeNull();
      // Ook aanmelden alleen is niet genoeg: een medewerker moet goedkeuren.
      await vreemde.client.rpc("klant_aanmelden");
      const naAanmelden = await vreemde.client
        .from("items")
        .insert({ owner_id: vreemde.userId, title: "aangemeld, niet goedgekeurd" });
      expect(naAanmelden.error).not.toBeNull();
      const { count } = await admin
        .from("items")
        .select("*", { count: "exact", head: true })
        .eq("owner_id", vreemde.userId);
      expect(count).toBe(0);

      const eigen = await goedgekeurd.client
        .from("items")
        .insert({ owner_id: goedgekeurd.userId, title: "van een goedgekeurde klant" })
        .select("id");
      expect(eigen.error).toBeNull();
      expect(eigen.data).toHaveLength(1);
      // De poort komt bovenop de regels die er al waren: het blijft alleen het eigen.
      const lezen = await vreemde.client.from("items").select("id");
      expect(lezen.data ?? []).toEqual([]);
      const namensAnder = await goedgekeurd.client
        .from("items")
        .insert({ owner_id: vreemde.userId, title: "namens een ander" });
      expect(namensAnder.error).not.toBeNull();

      // Een medewerker via Cloudflare komt ook door de poort.
      const alsMedewerker = await viaCloudflare.client
        .from("items")
        .insert({ owner_id: viaCloudflare.userId, title: "van een medewerker" })
        .select("id");
      expect(alsMedewerker.error).toBeNull();
      // Dezelfde persoon per mail niet.
      const perMailSchrijven = await perMail.client
        .from("items")
        .insert({ owner_id: perMail.userId, title: "per mail" });
      expect(perMailSchrijven.error).not.toBeNull();
    });
  });
});

describe("de poort van een klantportaal, gelezen uit de database zelf", () => {
  // Met `"klantportaal": true` draait deze controle in tests/rls/open-policies.test.ts en moet
  // de lijst leeg zijn. De template zelf is geen klantportaal; hier staat wat de controle in
  // de echte database vindt, zodat hij ook zonder de schakelaar bewezen is.
  it("vindt de tabel klanten en de functies van het klantportaal in orde, en het voorbeeld items niet", () => {
    const problemen = problemenKlantportaalInDatabase();
    expect(problemen.filter((probleem) => !probleem.startsWith("public.items "))).toEqual([]);
    expect(
      problemen.map((probleem) => /^public\.items \(policy "([^"]+)"\)/.exec(probleem)?.[1]),
    ).toEqual([
      "items_delete_own",
      "items_insert_own",
      "items_select_own",
      "items_update_own",
      "items_update_own",
    ]);
  });

  it("met de poort op items is er niets meer mis", async () => {
    await metPoortOp("items", async () => {
      expect(problemenKlantportaalInDatabase()).toEqual([]);
    });
  });
});

describe("een klant wijzigt zijn e-mailadres niet zelf", () => {
  // De inrichting zet de mail voor een adreswijziging dicht. Lokaal staat hij open; zo is te
  // bewijzen wat de database doet als het toch gebeurt.
  it("na een adreswijziging loopt het adres op de lijst mee, vervalt de goedkeuring en is de oude sessie uitgelogd", async () => {
    const eerst = nieuwAdres("eerst");
    const daarna = nieuwAdres("daarna");
    const sessie = await inloggenMetMailcode(eerst);
    opruimen.add(sessie.userId);
    await sessie.client.rpc("klant_aanmelden");
    await keurGoed(sessie.userId);
    expect(await isGoedgekeurd(sessie)).toBe(true);

    await wijzigAdres(sessie, eerst, daarna);

    // De medewerker ziet het adres dat nu op het account staat, en keurt opnieuw goed.
    expect(await regelVan(sessie.userId)).toEqual({ e_mail: daarna, goedgekeurd: false });
    await keurGoed(sessie.userId);
    // De sessie van vóór de wijziging heeft daar niets aan: die bestaat niet meer.
    expect(await isGoedgekeurd({ client: metToken(sessie.token) })).toBe(false);
    const verversen = await sessie.client.auth.refreshSession();
    expect(verversen.error).not.toBeNull();
    // Wie bij de mailbox van het nieuwe adres kan, logt gewoon in en is de goedgekeurde klant.
    const opnieuw = await inloggenMetMailcode(daarna);
    expect(opnieuw.userId).toBe(sessie.userId);
    expect(await isGoedgekeurd(opnieuw)).toBe(true);
  });

  it("aanmelden op andermans adres lukt niet: na de wijziging is de aanvaller zijn sessie kwijt", async () => {
    // De aanvaller wijzigt het adres van zijn eigen account in dat van een bekende klant; die
    // klikt alleen op "bevestig" in een mail. Zou de aanvaller zich daarna met zijn oude sessie
    // aanmelden, dan keurde de medewerker het adres van de klant goed op het account van de
    // aanvaller.
    const eigen = nieuwAdres("aanvaller");
    const vanSlachtoffer = nieuwAdres("bekende-klant");
    const sessie = await inloggenMetMailcode(eigen);
    opruimen.add(sessie.userId);

    await wijzigAdres(sessie, eigen, vanSlachtoffer);

    await sessie.client.rpc("klant_aanmelden");
    await metToken(sessie.token).rpc("klant_aanmelden");
    expect(await regelVan(sessie.userId)).toBeUndefined();
    // Ook als een medewerker het adres later goedkeurt (de klant zelf meldde zich aan), heeft
    // het oude token van de aanvaller geen rechten.
    const slachtoffer = await inloggenMetMailcode(vanSlachtoffer);
    expect(slachtoffer.userId).toBe(sessie.userId);
    await slachtoffer.client.rpc("klant_aanmelden");
    await keurGoed(sessie.userId);
    expect(await isGoedgekeurd(slachtoffer)).toBe(true);
    expect(await isGoedgekeurd({ client: metToken(sessie.token) })).toBe(false);
  });

  it("ook als een beheerder het adres wijzigt, vervalt de goedkeuring tot een medewerker opnieuw kijkt", async () => {
    const vers = await nieuweKlant("door-beheerder");
    await vers.client.rpc("klant_aanmelden");
    await keurGoed(vers.userId);
    const nieuw = nieuwAdres("door-beheerder-nieuw");
    const { error } = await admin.auth.admin.updateUserById(vers.userId, { email: nieuw });
    expect(error).toBeNull();
    expect(await regelVan(vers.userId)).toEqual({ e_mail: nieuw, goedgekeurd: false });
    expect(await isGoedgekeurd({ client: metToken(vers.token) })).toBe(false);
  });
});

describe("elke regel van de migratie heeft een test (de mutaties van de aanvaller)", () => {
  it("is_goedgekeurde_klant: de sessie van het token moet van dit account zijn", async () => {
    const goed = await nieuweKlant("sessie-eigen");
    await goed.client.rpc("klant_aanmelden");
    await keurGoed(goed.userId);
    const ander = await nieuweKlant("sessie-ontvanger");
    expect(await isGoedgekeurd({ client: metToken(goed.token) })).toBe(true);
    hangSessieAanAccount(goed.sessieId, ander.userId);
    expect(await isGoedgekeurd({ client: metToken(goed.token) })).toBe(false);
  });

  it("klant_aanmelden: de sessie van het token moet van dit account zijn", async () => {
    const vers = await nieuweKlant("aanmelden-eigen");
    const ander = await nieuweKlant("aanmelden-ontvanger");
    hangSessieAanAccount(vers.sessieId, ander.userId);
    await metToken(vers.token).rpc("klant_aanmelden");
    expect(await regelVan(vers.userId)).toBeUndefined();
  });

  it("elke security definer-functie van het klantportaal heeft een leeg, vast zoekpad", () => {
    const functies = vraagDatabase<{ naam: string; zoekpad: string[] | null }>(`
      select p.proname as naam, p.proconfig as zoekpad
        from pg_proc p
       where p.pronamespace = 'public'::regnamespace and p.prosecdef
       order by 1`);
    expect(functies.map((f) => f.naam)).toEqual(
      expect.arrayContaining([
        "is_goedgekeurde_klant",
        "is_medewerker",
        "klant_aanmelden",
        "klant_adres_gewijzigd",
        "sessie_via_cloudflare",
      ]),
    );
    for (const f of functies) expect(f.zoekpad, f.naam).toEqual(['search_path=""']);
  });

  it("de functie achter de trigger mag niemand aanroepen, en de tabel klanten heeft alleen de smalle rechten", () => {
    const [rechten] = vraagDatabase<{ trigger: string[]; klanten: string[] }>(`
      select
        array(select rol from unnest(array['public', 'anon', 'authenticated']) rol
               where rol <> 'public'
                 and has_function_privilege(rol, 'public.klant_adres_gewijzigd()', 'execute')) as trigger,
        array(select r.rol || ': ' || s.soort
                from unnest(array['anon', 'authenticated']) r(rol),
                     unnest(array['select', 'insert', 'update', 'delete', 'truncate']) s(soort)
               where has_table_privilege(r.rol, 'public.klanten', s.soort)
                  or (s.soort = 'update' and has_column_privilege(r.rol, 'public.klanten', 'goedgekeurd', 'update'))
               order by 1) as klanten`);
    expect(rechten?.trigger).toEqual([]);
    expect(rechten?.klanten).toEqual(["authenticated: select", "authenticated: update"]);
    const [kolommen] = vraagDatabase<{ e_mail: boolean; user_id: boolean }>(`
      select has_column_privilege('authenticated', 'public.klanten', 'e_mail', 'update') as e_mail,
             has_column_privilege('authenticated', 'public.klanten', 'user_id', 'update') as user_id`);
    expect(kolommen).toEqual({ e_mail: false, user_id: false });
  });

  it("na een adreswijziging eindigen de sessies, ook van een account dat zich nooit aanmeldde", async () => {
    const vers = await nieuweKlant("niet-aangemeld");
    expect(await regelVan(vers.userId)).toBeUndefined();
    const { error } = await admin.auth.admin.updateUserById(vers.userId, {
      email: nieuwAdres("niet-aangemeld-nieuw"),
    });
    expect(error).toBeNull();
    const verversen = await vers.client.auth.refreshSession();
    expect(verversen.error).not.toBeNull();
  });

  it("ook als het adres leeg wordt, vervalt de goedkeuring en eindigen de sessies", async () => {
    const vers = await nieuweKlant("adres-leeg");
    await vers.client.rpc("klant_aanmelden");
    await keurGoed(vers.userId);
    expect(await isGoedgekeurd(vers)).toBe(true);
    zetAdresLeeg(vers.userId);
    expect(await regelVan(vers.userId)).toEqual({ e_mail: "", goedgekeurd: false });
    expect(await isGoedgekeurd({ client: metToken(vers.token) })).toBe(false);
  });

  it("een koppeling met een telefoonnummer telt als tweede inlogmanier: geen medewerker", async () => {
    await metAccountViaDienst("telefoon", async (sessie) => {
      noemIdentiteitCloudflare(sessie.userId);
      expect(await isMedewerker(sessie)).toBe(true);
      voegKoppelingToe(sessie.userId, "phone");
      expect(await isMedewerker(sessie)).toBe(false);
    });
  });

  it("een geblokkeerd account (ban) heeft met zijn lopende token geen rechten meer", async () => {
    await metAccountViaDienst("geblokkeerd", async (sessie) => {
      noemIdentiteitCloudflare(sessie.userId);
      expect(await isMedewerker(sessie)).toBe(true);
      const { error } = await admin.auth.admin.updateUserById(sessie.userId, {
        ban_duration: "24h",
      });
      expect(error).toBeNull();
      expect(await isMedewerker({ client: metToken(sessie.token) })).toBe(false);
      const { data } = await metToken(sessie.token).rpc("sessie_via_cloudflare");
      expect(data).toBe(false);
    });
    const vers = await nieuweKlant("klant-geblokkeerd");
    await vers.client.rpc("klant_aanmelden");
    await keurGoed(vers.userId);
    expect(await isGoedgekeurd(vers)).toBe(true);
    const { error } = await admin.auth.admin.updateUserById(vers.userId, { ban_duration: "24h" });
    expect(error).toBeNull();
    expect(await isGoedgekeurd({ client: metToken(vers.token) })).toBe(false);
  });
});
