import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Actor,
  admin,
  anoniem,
  controleerAfscherming,
  maakActor,
  verwijderActor,
} from "./lib/afscherming";
import {
  geefAndereIdentiteit,
  geefCloudflareIdentiteit,
  inloggenMetMailcode,
  leesToken,
  maakAccount,
  maakCloudflareSessie,
  metToken,
  nieuwAdres,
  type Sessie,
  verwijderAccount,
} from "./lib/sessies";

/**
 * Het klantportaal: medewerkers en klanten in dezelfde app, zonder deur ervoor.
 *
 * De regel (docs/WERKWIJZE.md): een recht hangt nooit aan iets wat een klant zelf kan
 * claimen. Medewerkerrechten zijn er alleen in een sessie die via Cloudflare begon. Wie per
 * mail inlogt op het adres van een medewerker, komt op hetzelfde account uit (Supabase kent
 * één account per adres) en is toch gewoon klant.
 *
 * Alles hier logt echt in bij de lokale Supabase, met de code uit de lokale mailvanger. Hoe
 * de sessie "via Cloudflare" lokaal ontstaat, staat in tests/rls/lib/sessies.ts.
 */
let medewerker: { id: string; email: string };
let viaCloudflare: Sessie;
let perMail: Sessie;
let klant: Sessie;
const opruimen: string[] = [];

beforeAll(async () => {
  // Een medewerker die ooit via Cloudflare is binnengekomen: een account zonder wachtwoord,
  // met een Cloudflare-identiteit.
  medewerker = await maakAccount("medewerker");
  opruimen.push(medewerker.id);
  geefCloudflareIdentiteit(medewerker.id, medewerker.email);

  viaCloudflare = await maakCloudflareSessie(await inloggenMetMailcode(medewerker.email));
  // Iemand met toegang tot de mailbox van de medewerker vraagt een code aan op dat adres.
  perMail = await inloggenMetMailcode(medewerker.email);

  // Een nieuwe klant: het adres bestaat nog niet, inloggen per mail maakt het account.
  klant = await inloggenMetMailcode(nieuwAdres("klant"));
  opruimen.push(klant.userId);
  const { error } = await klant.client.rpc("klant_aanmelden");
  if (error) throw new Error(`De klant kon zich niet aanmelden: ${error.message}`);
});

afterAll(async () => {
  for (const id of opruimen) await verwijderAccount(id);
});

async function isMedewerker(sessie: Pick<Sessie, "client">): Promise<boolean | null> {
  const { data, error } = await sessie.client.rpc("is_medewerker");
  if (error) throw new Error(`is_medewerker gaf een fout: ${error.message}`);
  return data;
}

describe("waar de controle op vertrouwt: wat Supabase in het token zet", () => {
  it("een mailsessie op het adres van een medewerker is hetzelfde account", () => {
    // Dit is de valkuil: wie op auth.uid() of het e-mailadres vertrouwt, ziet geen verschil.
    expect(perMail.userId).toBe(medewerker.id);
    expect(viaCloudflare.userId).toBe(medewerker.id);
    expect(leesToken(perMail.token).email).toBe(medewerker.email);
    expect(perMail.sessieId).not.toBe(viaCloudflare.sessieId);
  });

  it("het token zegt hoe de sessie begon: per mail is nooit oauth", () => {
    expect(perMail.methodes).toEqual(["otp"]);
    expect(klant.methodes).not.toContain("oauth");
    expect(viaCloudflare.methodes).toEqual(["oauth"]);
  });

  it("app_metadata zegt het niet: daar staat Cloudflare ook bij een mailsessie", async () => {
    // providers is de lijst van alles wat aan het account hangt, niet hoe deze sessie begon.
    const { data } = await admin.auth.admin.getUserById(medewerker.id);
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

  it("een klant is geen medewerker, en een bezoeker zonder inlog mag het niet eens vragen", async () => {
    expect(await isMedewerker(klant)).toBe(false);
    const { data, error } = await anoniem().rpc("is_medewerker");
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it("blijft nee na verversen van het token", async () => {
    const { error } = await perMail.client.auth.refreshSession();
    expect(error).toBeNull();
    expect(await isMedewerker(perMail)).toBe(false);
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
      geefCloudflareIdentiteit(actor.id, actor.email);
      expect(await isMedewerker(actor)).toBe(false);
    } finally {
      await verwijderActor(actor);
    }
  });

  it("hangt er een tweede inlogdienst aan het account, dan zegt de functie nee", async () => {
    // amr zegt "via een inlogdienst", niet welke. Met twee diensten is niet meer te zeggen
    // dat het Cloudflare was, en dan is het antwoord nee.
    const account = await maakAccount("twee-diensten");
    try {
      geefCloudflareIdentiteit(account.id, account.email);
      const sessie = await maakCloudflareSessie(await inloggenMetMailcode(account.email));
      expect(await isMedewerker(sessie)).toBe(true);
      geefAndereIdentiteit(account.id, "google");
      expect(await isMedewerker(sessie)).toBe(false);
    } finally {
      await verwijderAccount(account.id);
    }
  });

  it("zonder Cloudflare-identiteit is ook een oauth-sessie geen medewerker", async () => {
    const account = await maakAccount("zonder-cloudflare");
    try {
      const sessie = await maakCloudflareSessie(await inloggenMetMailcode(account.email));
      expect(sessie.methodes).toEqual(["oauth"]);
      expect(await isMedewerker(sessie)).toBe(false);
    } finally {
      await verwijderAccount(account.id);
    }
  });

  it("na uitloggen is het recht meteen weg, ook met het oude token", async () => {
    const account = await maakAccount("uitgelogd");
    try {
      geefCloudflareIdentiteit(account.id, account.email);
      const sessie = await maakCloudflareSessie(await inloggenMetMailcode(account.email));
      const oudToken = sessie.token;
      expect(await isMedewerker({ client: metToken(oudToken) })).toBe(true);
      await sessie.client.auth.signOut({ scope: "local" });
      expect(await isMedewerker({ client: metToken(oudToken) })).toBe(false);
    } finally {
      await verwijderAccount(account.id);
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
