import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type NepInlogdienst, type Persoon, startNepInlogdienst } from "./lib/inlogdienst-nep";
import {
  accountsVan,
  inloggenMetMailcode,
  leesToken,
  metToken,
  nieuwPersoon,
  noemIdentiteitCloudflare,
  type Sessie,
  sessieViaInlogdienst,
  verwijderAccount,
  zetSessieBegin,
} from "./lib/sessies";
import { codeVoor } from "./lib/inlogdienst-nep";

/**
 * AANVAL, doel 1: medewerkerrechten zonder verse sessie via Cloudflare.
 * Elke test SLAAGT als de aanval lukt. Rood betekent: de verdediging hield stand.
 *
 * De aanvaller is hier iemand die bij de mailbox van een medewerker kan (het scenario uit
 * docs/WERKWIJZE.md), of een gewone klant.
 */
const url = String(import.meta.env.SUPABASE_URL);
const anonKey = String(import.meta.env.SUPABASE_ANON_KEY);

let dienst: NepInlogdienst;
let medewerker: Persoon;
let viaCloudflare: Sessie;
let perMail: Sessie;
const opruimen = new Set<string>();

async function isMedewerker(sessie: Pick<Sessie, "client">): Promise<boolean> {
  const { data, error } = await sessie.client.rpc("is_medewerker");
  if (error) throw new Error(`is_medewerker gaf een fout: ${error.message}`);
  return data === true;
}

function b64(waarde: unknown): string {
  return Buffer.from(JSON.stringify(waarde)).toString("base64url");
}

beforeAll(async () => {
  dienst = await startNepInlogdienst();
  medewerker = nieuwPersoon("aanval-mw", { adresBevestigd: true });
  viaCloudflare = await sessieViaInlogdienst(medewerker);
  opruimen.add(viaCloudflare.userId);
  noemIdentiteitCloudflare(viaCloudflare.userId);
  if (!(await isMedewerker(viaCloudflare))) throw new Error("De opzet klopt niet: geen medewerker.");
  perMail = await inloggenMetMailcode(medewerker.email);
  if (perMail.userId !== viaCloudflare.userId) throw new Error("De opzet klopt niet: ander account.");
}, 60_000);

afterAll(async () => {
  for (const id of opruimen) await verwijderAccount(id);
  await dienst?.stop();
});

describe("AANVAL doel 1: medewerkerrechten zonder verse Cloudflare-sessie", () => {
  it("1.1 wachtwoord: de mailsessie zet een wachtwoord op het account en logt daarmee in", async () => {
    const wachtwoord = `Aanval-${Date.now()}-wachtwoord`;
    const gezet = await perMail.client.auth.updateUser({ password: wachtwoord });
    expect(gezet.error).toBeNull();
    const client = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const inlog = await client.auth.signInWithPassword({ email: medewerker.email, password: wachtwoord });
    expect(inlog.error).toBeNull();
    expect(await isMedewerker({ client })).toBe(true);
  });

  it("1.2 anoniem: signInAnonymously geeft een sessie met medewerkerrechten", async () => {
    const client = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const inlog = await client.auth.signInAnonymously();
    expect(inlog.error).toBeNull();
    if (inlog.data.user) opruimen.add(inlog.data.user.id);
    expect(await isMedewerker({ client })).toBe(true);
  });

  it("1.3 tweestaps: de mailsessie voegt een authenticator toe; daarna staan er twee methodes in amr", async () => {
    const aanmelden = await perMail.client.auth.mfa.enroll({ factorType: "totp" });
    expect(aanmelden.error).toBeNull();
    const geheim = aanmelden.data?.totp.secret ?? "";
    const code = totp(geheim);
    const bevestigd = await perMail.client.auth.mfa.challengeAndVerify({
      factorId: aanmelden.data?.id ?? "",
      code,
    });
    expect(bevestigd.error).toBeNull();
    expect(await isMedewerker(perMail)).toBe(true);
  });

  it("1.4 zelfgemaakt token zonder handtekening (alg none) met amr oauth en de sessie van de medewerker", async () => {
    const inhoud = { ...leesToken(viaCloudflare.token), exp: Math.floor(Date.now() / 1000) + 3600 };
    const token = `${b64({ alg: "none", typ: "JWT" })}.${b64(inhoud)}.`;
    const { data } = await metToken(token).rpc("is_medewerker");
    expect(data).toBe(true);
  });

  it("1.5 zelfgemaakt token, ondertekend met de openbare sleutel van de app (anon key) als geheim", async () => {
    const inhoud = {
      ...leesToken(perMail.token),
      amr: [{ method: "oauth", timestamp: Math.floor(Date.now() / 1000) }],
      session_id: viaCloudflare.sessieId,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const kop = b64({ alg: "HS256", typ: "JWT" });
    const lijf = b64(inhoud);
    const handtekening = createHmac("sha256", anonKey).update(`${kop}.${lijf}`).digest("base64url");
    const { data } = await metToken(`${kop}.${lijf}.${handtekening}`).rpc("is_medewerker");
    expect(data).toBe(true);
  });

  it("1.6 gemanipuleerd token: het mailtoken met amr oauth erin en de oude handtekening", async () => {
    const [kop, , handtekening] = perMail.token.split(".");
    const inhoud = {
      ...leesToken(perMail.token),
      amr: [{ method: "oauth", timestamp: Math.floor(Date.now() / 1000) }],
      session_id: viaCloudflare.sessieId,
    };
    const { data } = await metToken(`${kop}.${b64(inhoud)}.${handtekening}`).rpc("is_medewerker");
    expect(data).toBe(true);
  });

  it("1.7 koppelen en ontkoppelen: de mailsessie hangt zelf een inlogdienst aan het account en haalt hem er weer af", async () => {
    // Lukt het koppelen, dan begint Supabase een nieuwe sessie met amr oauth op het account van
    // de medewerker. Lukt daarna het ontkoppelen, dan is de tweede dienst weer weg en zegt
    // sessie_via_cloudflare() ja.
    const begin = await fetch(
      `${url}/auth/v1/user/identities/authorize?provider=keycloak&skip_http_redirect=true`,
      { headers: { apikey: anonKey, Authorization: `Bearer ${perMail.token}` } },
    );
    expect(begin.status).toBe(200);
    const naarDienst = ((await begin.json()) as { url?: string }).url ?? "";
    const state = new URL(naarDienst).searchParams.get("state") ?? "";
    const aanvaller = { sub: `aanvaller-${Date.now()}`, email: "aanvaller@voorbeeld.nl", email_verified: true };
    const terug = await fetch(
      `${url}/auth/v1/callback?${new URLSearchParams({ code: codeVoor(aanvaller), state })}`,
      { redirect: "manual" },
    );
    const anker = new URLSearchParams(new URL(terug.headers.get("location") ?? "").hash.slice(1));
    const access_token = anker.get("access_token") ?? "";
    const refresh_token = anker.get("refresh_token") ?? "";
    const client = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    await client.auth.setSession({ access_token, refresh_token });
    const { data } = await client.auth.getUserIdentities();
    const erbij = data?.identities.find((identiteit) => identiteit.provider === "keycloak");
    if (erbij) await client.auth.unlinkIdentity(erbij);
    expect(await isMedewerker({ client })).toBe(true);
  });

  it("1.8 een tweede inlogdienst met hetzelfde (bevestigde) adres: de aanvaller krijgt een oauth-sessie op het account van de medewerker", async () => {
    // Lokaal is er naast `custom:cloudflare` (omgedoopt) nog de dienst onder zijn eigen naam.
    // Wie daar het adres van de medewerker mag claimen, komt op hetzelfde account uit.
    const persoon = nieuwPersoon("aanval-tweede", { adresBevestigd: true });
    const eerste = await sessieViaInlogdienst(persoon);
    try {
      noemIdentiteitCloudflare(eerste.userId);
      const aanvaller = await sessieViaInlogdienst({
        sub: `iemand-anders-${Date.now()}`,
        email: persoon.email,
        email_verified: true,
      });
      expect(aanvaller.userId).toBe(eerste.userId);
      expect(aanvaller.methodes).toEqual(["oauth"]);
      expect(await isMedewerker(aanvaller)).toBe(true);
    } finally {
      for (const id of await accountsVan(persoon)) await verwijderAccount(id);
    }
  });

  it("1.9 GELUKT ALS: dezelfde aanval haalt de medewerker zelf onderuit (zijn lopende Cloudflare-sessie verliest de rechten)", async () => {
    const persoon = nieuwPersoon("aanval-dos", { adresBevestigd: true });
    const eerste = await sessieViaInlogdienst(persoon);
    try {
      noemIdentiteitCloudflare(eerste.userId);
      expect(await isMedewerker(eerste)).toBe(true);
      await sessieViaInlogdienst({ sub: `ander-${Date.now()}`, email: persoon.email, email_verified: true });
      expect(await isMedewerker(eerste)).toBe(false);
    } finally {
      for (const id of await accountsVan(persoon)) await verwijderAccount(id);
    }
  });

  it("1.10 twaalf uur ontlopen zonder Cloudflare: verversen, de sessie in een nieuwe client zetten, het account bijwerken", async () => {
    const persoon = nieuwPersoon("aanval-12u", { adresBevestigd: true });
    const sessie = await sessieViaInlogdienst(persoon);
    try {
      noemIdentiteitCloudflare(sessie.userId);
      zetSessieBegin(sessie.sessieId, 13);
      for (let keer = 0; keer < 3; keer++) await sessie.client.auth.refreshSession();
      await sessie.client.auth.updateUser({ data: { iets: "anders" } });
      const { data } = await sessie.client.auth.getSession();
      const client = createClient(url, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      await client.auth.setSession({
        access_token: data.session?.access_token ?? "",
        refresh_token: data.session?.refresh_token ?? "",
      });
      await client.auth.refreshSession();
      expect((await isMedewerker(sessie)) || (await isMedewerker({ client }))).toBe(true);
    } finally {
      for (const id of await accountsVan(persoon)) await verwijderAccount(id);
    }
  });

  it("1.12 rechtstreeks via de API: de tabellen van Supabase Auth lezen of schrijven (auth.sessions, auth.identities)", async () => {
    const pogingen = await Promise.all(
      ["auth", "public"].flatMap((schema) =>
        ["sessions", "identities", "mfa_amr_claims"].map(async (tabel) => {
          const antwoord = await fetch(`${url}/rest/v1/${tabel}?select=*&limit=1`, {
            headers: {
              apikey: anonKey,
              Authorization: `Bearer ${perMail.token}`,
              "Accept-Profile": schema,
            },
          });
          return antwoord.status;
        }),
      ),
    );
    expect(pogingen).toContain(200);
  });

  it("1.13 de functie misleiden met een eigen functie of extra argumenten via rpc", async () => {
    const pogingen = await Promise.all([
      perMail.client.rpc("is_medewerker", { amr: [{ method: "oauth" }] } as never),
      perMail.client.rpc("sessie_via_cloudflare", { session_id: viaCloudflare.sessieId } as never),
      perMail.client.rpc("jwt" as never),
      perMail.client.rpc("set_config" as never, {
        setting_name: "request.jwt.claims",
        new_value: JSON.stringify(leesToken(viaCloudflare.token)),
        is_local: false,
      } as never),
    ]);
    const gelukt = pogingen.some((poging) => poging.error === null && poging.data !== false);
    expect(gelukt || (await isMedewerker(perMail))).toBe(true);
  });

  it("1.14 het token van de medewerker na uitloggen overal (scope global) werkt nog voor medewerkerrechten", async () => {
    const persoon = nieuwPersoon("aanval-uit", { adresBevestigd: true });
    const sessie = await sessieViaInlogdienst(persoon);
    try {
      noemIdentiteitCloudflare(sessie.userId);
      const oud = sessie.token;
      // Een ander (de mailsessie op hetzelfde account) logt iedereen uit; het oude token is
      // nog een uur geldig.
      const mail = await inloggenMetMailcode(persoon.email);
      await mail.client.auth.signOut({ scope: "others" });
      expect(await isMedewerker({ client: metToken(oud) })).toBe(true);
    } finally {
      for (const id of await accountsVan(persoon)) await verwijderAccount(id);
    }
  });
});

/** Een TOTP-code (RFC 6238, SHA-1, 30 s, 6 cijfers) uit een base32-geheim. */
function totp(geheim: string): string {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const teken of geheim.replace(/=+$/, "").toUpperCase()) {
    const waarde = letters.indexOf(teken);
    if (waarde >= 0) bits += waarde.toString(2).padStart(5, "0");
  }
  const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2)));
  const teller = Buffer.alloc(8);
  teller.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const hmac = createHmac("sha1", bytes).update(teller).digest();
  const plek = (hmac[hmac.length - 1] ?? 0) & 0xf;
  const getal = (hmac.readUInt32BE(plek) & 0x7fffffff) % 1_000_000;
  return String(getal).padStart(6, "0");
}
