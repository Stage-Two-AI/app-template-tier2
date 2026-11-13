import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin } from "./lib/afscherming";
import { anonKey, linksUit, url, wacht, wachtOpMailHtml } from "./lib/aanval-hulp";
import { inloggenMetMailcode, nieuwAdres, type Sessie, verwijderAccount } from "./lib/sessies";

/**
 * AANVAL, doel 2: een klant ziet of wijzigt wat hij niet mag (`klanten`, `items`).
 * Elke test SLAAGT als de aanval lukt. Rood betekent: de verdediging hield stand.
 */
let aanvaller: Sessie;
let slachtoffer: Sessie;
const opruimen = new Set<string>();

async function goedgekeurd(userId: string): Promise<boolean | undefined> {
  const { data } = await admin.from("klanten").select("goedgekeurd").eq("user_id", userId);
  return data?.[0]?.goedgekeurd;
}

async function graphql(sessie: Sessie, query: string): Promise<{ status: number; tekst: string }> {
  const antwoord = await fetch(`${url}/graphql/v1`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${sessie.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  return { status: antwoord.status, tekst: await antwoord.text() };
}

beforeAll(async () => {
  aanvaller = await inloggenMetMailcode(nieuwAdres("aanval-klant"));
  opruimen.add(aanvaller.userId);
  slachtoffer = await inloggenMetMailcode(nieuwAdres("aanval-slachtoffer"));
  opruimen.add(slachtoffer.userId);
  for (const sessie of [aanvaller, slachtoffer]) {
    const { error } = await sessie.client.rpc("klant_aanmelden");
    if (error) throw new Error(`Aanmelden mislukt: ${error.message}`);
  }
}, 60_000);

afterAll(async () => {
  for (const id of opruimen) await verwijderAccount(id);
});

describe("AANVAL doel 2: een klant ziet of wijzigt wat hij niet mag", () => {
  it("2.1 zichzelf goedkeuren: via upsert, via alle kolommen tegelijk en via GraphQL", async () => {
    await aanvaller.client
      .from("klanten")
      .upsert({ user_id: aanvaller.userId, e_mail: "x@y.nl", goedgekeurd: true } as never);
    await aanvaller.client.from("klanten").update({ goedgekeurd: true } as never).neq("e_mail", "");
    await graphql(
      aanvaller,
      "mutation { updateklantenCollection(set: {goedgekeurd: true}, atMost: 100) { affectedCount } }",
    );
    expect(await goedgekeurd(aanvaller.userId)).toBe(true);
  });

  it("2.2 een ander zien: via de tabel, een telling, GraphQL of een antwoord op een wijziging", async () => {
    const lijst = await aanvaller.client.from("klanten").select("user_id, e_mail");
    const telling = await aanvaller.client.from("klanten").select("*", { count: "exact", head: true });
    const viaGraphql = await graphql(
      aanvaller,
      "{ klantenCollection { edges { node { user_id e_mail } } } }",
    );
    const adres = (await admin.auth.admin.getUserById(slachtoffer.userId)).data.user?.email ?? "?";
    const gezien =
      (lijst.data ?? []).some((rij) => rij.user_id === slachtoffer.userId) ||
      (telling.count ?? 0) > 1 ||
      viaGraphql.tekst.includes(slachtoffer.userId) ||
      viaGraphql.tekst.includes(adres);
    expect(gezien).toBe(true);
  });

  it("2.3 kolommen die alleen een medewerker (of niemand) mag wijzigen: adres, datum, eigenaar; of de eigen regel weghalen", async () => {
    const pogingen = await Promise.all([
      aanvaller.client.from("klanten").update({ e_mail: "directie@bedrijf.nl" } as never).eq("user_id", aanvaller.userId),
      aanvaller.client.from("klanten").update({ aangemeld_op: "2000-01-01" } as never).eq("user_id", aanvaller.userId),
      aanvaller.client.from("klanten").update({ user_id: slachtoffer.userId } as never).eq("user_id", aanvaller.userId),
      aanvaller.client.from("klanten").delete().eq("user_id", slachtoffer.userId),
    ]);
    const { data } = await admin.from("klanten").select("e_mail, aangemeld_op").eq("user_id", aanvaller.userId);
    const nogDaar = await goedgekeurd(slachtoffer.userId);
    const gelukt =
      pogingen.some((poging) => poging.error === null && (poging.count ?? 0) > 0) ||
      data?.[0]?.e_mail === "directie@bedrijf.nl" ||
      String(data?.[0]?.aangemeld_op).startsWith("2000") ||
      nogDaar === undefined;
    expect(gelukt).toBe(true);
  });

  it("2.4 klant_aanmelden() met andermans gegevens: argumenten meesturen of namens een ander aanroepen", async () => {
    const pogingen = await Promise.all([
      aanvaller.client.rpc("klant_aanmelden", { e_mail: "directie@bedrijf.nl" } as never),
      aanvaller.client.rpc("klant_aanmelden", { user_id: slachtoffer.userId, goedgekeurd: true } as never),
    ]);
    const { data } = await admin.from("klanten").select("e_mail").eq("user_id", aanvaller.userId);
    expect(pogingen.some((p) => p.error === null) && data?.[0]?.e_mail === "directie@bedrijf.nl").toBe(true);
  });

  it("2.5 GELUKT ALS: een account dat niet is aangemeld en niet is goedgekeurd schrijft toch in de app (`items`)", async () => {
    // "Een nieuwe klant mag niets tot een medewerker hem goedkeurt" (docs/WERKWIJZE.md). In een
    // klantportaal is `to authenticated` iedereen op internet met een e-mailadres.
    const vreemde = await inloggenMetMailcode(nieuwAdres("aanval-vreemde"));
    opruimen.add(vreemde.userId);
    const rijen = Array.from({ length: 200 }, (_, nummer) => ({
      owner_id: vreemde.userId,
      title: `x`.repeat(119) + (nummer % 10),
    }));
    const { error } = await vreemde.client.from("items").insert(rijen);
    expect(error).toBeNull();
    const { count } = await admin.from("items").select("*", { count: "exact", head: true }).eq("owner_id", vreemde.userId);
    expect(count).toBe(200);
  });

  it("2.6 GELUKT ALS: massaal aanmelden; elk nieuw adres is een regel in de lijst van de medewerker, zonder grens in de app", async () => {
    const voor = (await admin.from("klanten").select("*", { count: "exact", head: true })).count ?? 0;
    for (let nummer = 0; nummer < 4; nummer++) {
      const nep = await inloggenMetMailcode(nieuwAdres(`aanval-massa${nummer}`));
      opruimen.add(nep.userId);
      const { error } = await nep.client.rpc("klant_aanmelden");
      expect(error).toBeNull();
      await wacht(200);
    }
    const na = (await admin.from("klanten").select("*", { count: "exact", head: true })).count ?? 0;
    expect(na - voor).toBe(4);
  });

  it("2.7 GELUKT ALS: het adres in `klanten` klopt niet meer met het account (de klant wijzigt zijn adres na de aanmelding)", async () => {
    // De medewerker keurt goed op wat er in `klanten.e_mail` staat. Dat is een momentopname:
    // het account kan daarna een ander adres krijgen (en dus van een ander zijn).
    const eerst = nieuwAdres("aanval-eerst");
    const daarna = nieuwAdres("aanval-daarna");
    const sessie = await inloggenMetMailcode(eerst);
    opruimen.add(sessie.userId);
    await sessie.client.rpc("klant_aanmelden");
    const naarOud = await wachtOpMailHtml(eerst);
    const naarNieuw = await wachtOpMailHtml(daarna);
    await wacht(1200);
    const wijziging = await sessie.client.auth.updateUser({ email: daarna });
    expect(wijziging.error).toBeNull();
    for (const lees of [naarOud, naarNieuw]) {
      const html = await lees(8000);
      const link = linksUit(html ?? "").find((href) => href.includes("/auth/v1/verify"));
      if (link) await fetch(link, { redirect: "manual" });
    }
    const account = (await admin.auth.admin.getUserById(sessie.userId)).data.user?.email;
    const { data } = await admin.from("klanten").select("e_mail").eq("user_id", sessie.userId);
    expect(account).toBe(daarna);
    expect(data?.[0]?.e_mail).toBe(eerst);
  });

  it("2.8 GELUKT ALS: aanmelden op andermans adres; het slachtoffer klikt alleen op 'bevestig' in een mail van de app, de aanvaller houdt de sessie", async () => {
    // De aanvaller wijzigt het adres van zijn eigen account in dat van een bekende klant. Die
    // krijgt een bevestigingsmail van de app zelf. Na één klik staat het adres van het
    // slachtoffer op het account van de aanvaller, en meldt de aanvaller zich daarmee aan.
    const eigen = nieuwAdres("aanval-eigen");
    const vanSlachtoffer = nieuwAdres("bekende-klant");
    const sessie = await inloggenMetMailcode(eigen);
    opruimen.add(sessie.userId);
    const naarEigen = await wachtOpMailHtml(eigen);
    const naarSlachtoffer = await wachtOpMailHtml(vanSlachtoffer);
    await wacht(1200);
    const wijziging = await sessie.client.auth.updateUser({ email: vanSlachtoffer });
    expect(wijziging.error).toBeNull();
    for (const lees of [naarEigen, naarSlachtoffer]) {
      const html = await lees(8000);
      const link = linksUit(html ?? "").find((href) => href.includes("/auth/v1/verify"));
      if (link) await fetch(link, { redirect: "manual" });
    }
    // De oude sessie van de aanvaller leeft nog.
    const aanmelden = await sessie.client.rpc("klant_aanmelden");
    expect(aanmelden.error).toBeNull();
    const { data } = await admin.from("klanten").select("e_mail").eq("user_id", sessie.userId);
    expect(data?.[0]?.e_mail).toBe(vanSlachtoffer);
  });
});
