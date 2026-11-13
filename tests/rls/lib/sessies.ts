import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../../src/lib/database.types";
import { wachtOpInlogmail } from "../../lib/mailvanger";
import { admin } from "./afscherming";
import { codeVoor, type Persoon } from "./inlogdienst-nep";

/**
 * Sessies voor de tests van het klantportaal (tests/rls/klantportaal.test.ts). Elke sessie
 * hier begint echt bij de lokale Supabase Auth, en elk token is door Supabase zelf gemaakt
 * en ondertekend:
 *
 *   per mail              `inloggenMetMailcode`: een code aanvragen en de code uit de lokale
 *                         mailvanger invullen, zoals een klant.
 *   via een inlogdienst   `inloggenViaInlogdienst`: de terugkeer van een inlogdienst, tegen
 *                         de nagebootste dienst uit inlogdienst-nep.ts. Supabase wisselt de
 *                         code zelf om, koppelt de persoon aan een account en begint de
 *                         sessie. Wat er in het token staat over hoe de sessie begon
 *                         (`amr`), schrijft Supabase dus zelf; de test raakt het niet aan.
 *
 * Eén ding kan lokaal niet echt: de naam van de dienst. De nagebootste dienst hangt in het
 * vak `keycloak` (waarom: zie inlogdienst-nep.ts), en `sessie_via_cloudflare()` vraagt om
 * `custom:cloudflare`. `noemIdentiteitCloudflare` zet daarom, als beheerder van de database,
 * alleen de naam van de dienst om op de koppeling die Supabase zelf heeft gemaakt. Dat kan
 * alleen wie de database beheert; een klant kan het niet. Wat de tests dus met echte tokens
 * bewijzen: een sessie per mail op het account van een medewerker krijgt van Supabase nooit
 * `oauth` en heeft geen medewerkerrechten, en een sessie via de inlogdienst op datzelfde
 * account heeft ze wel. Wat ze niet bewijzen: dat de echte Cloudflare bij Supabase
 * `custom:cloudflare` heet; dat zet de inrichting, en dat is te zien in het project zelf.
 */

function nodig(naam: string, waarde: string | undefined): string {
  if (!waarde) throw new Error(`${naam} ontbreekt. Draai \`pnpm db:start\` en \`pnpm env:local\`.`);
  return waarde;
}

const url = nodig("SUPABASE_URL", import.meta.env.SUPABASE_URL);
const anonKey = nodig("SUPABASE_ANON_KEY", import.meta.env.SUPABASE_ANON_KEY);
const mailUrl: string | undefined = import.meta.env.SUPABASE_MAIL_URL;

/** Onder deze naam kent de lokale Supabase de nagebootste inlogdienst. */
export const LOKALE_DIENST = "keycloak";

export type Sessie = {
  client: SupabaseClient<Database>;
  userId: string;
  sessieId: string;
  /** Hoe deze sessie volgens het token is begonnen, bijvoorbeeld ["otp"] of ["oauth"]. */
  methodes: string[];
  token: string;
};

function nieuweClient(): SupabaseClient<Database> {
  return createClient<Database>(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Een client die alleen dit ene token meestuurt, ook als de sessie al is beëindigd. */
export function metToken(token: string): SupabaseClient<Database> {
  return createClient<Database>(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

/** De inhoud van een token lezen. Alleen om te tonen wat Supabase erin zet. */
export function leesToken(token: string): Record<string, unknown> {
  const deel = token.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(deel, "base64url").toString("utf8")) as Record<string, unknown>;
}

async function alsSessie(client: SupabaseClient<Database>): Promise<Sessie> {
  const { data, error } = await client.auth.getSession();
  if (error || !data.session) throw new Error(`Geen sessie: ${error?.message ?? "leeg"}`);
  const inhoud = leesToken(data.session.access_token);
  const amr = Array.isArray(inhoud.amr) ? inhoud.amr : [];
  return {
    client,
    userId: data.session.user.id,
    sessieId: String(inhoud.session_id),
    methodes: amr.map((stap) => String((stap as { method?: unknown }).method)),
    token: data.session.access_token,
  };
}

const wacht = (ms: number) => new Promise((klaar) => setTimeout(klaar, ms));

/** De code uit een inlogmail invullen. Geeft de sessie die Supabase daarvoor begint. */
export async function inloggenMetCode(email: string, code: string): Promise<Sessie> {
  const client = nieuweClient();
  const { error } = await client.auth.verifyOtp({ email, token: code, type: "email" });
  if (error) throw new Error(`Inloggen met de code mislukt: ${error.message}`);
  return alsSessie(client);
}

/** Echt inloggen met de code uit de mail, zoals een klant dat doet. */
export async function inloggenMetMailcode(email: string): Promise<Sessie> {
  const client = nieuweClient();
  const leesMail = await wachtOpInlogmail({ email, mailUrl });
  let aanvraag = await client.auth.signInWithOtp({ email });
  if (aanvraag.error?.status === 429) {
    // Supabase stuurt per adres niet vaker dan eens per seconde (max_frequency in config.toml).
    await wacht(1500);
    aanvraag = await client.auth.signInWithOtp({ email });
  }
  if (aanvraag.error) throw new Error(`Code aanvragen mislukt: ${aanvraag.error.message}`);
  const { code } = await leesMail();
  return inloggenMetCode(email, code);
}

export type ViaInlogdienst =
  | { ok: true; sessie: Sessie }
  /** Supabase weigerde. `code` en `tekst` zijn wat de inlogpagina in het adres terugkrijgt. */
  | { ok: false; code: string; tekst: string };

/**
 * Inloggen via de nagebootste inlogdienst, zoals een medewerker via Cloudflare: Supabase
 * Auth doorloopt de hele terugkeer zelf. Alleen het scherm van de dienst is overgeslagen:
 * de test zegt wie er bij de dienst is ingelogd.
 */
export async function inloggenViaInlogdienst(persoon: Persoon): Promise<ViaInlogdienst> {
  const begin = await fetch(`${url}/auth/v1/authorize?provider=${LOKALE_DIENST}`, {
    redirect: "manual",
  });
  const naarDienst = begin.headers.get("location");
  const state = naarDienst ? new URL(naarDienst).searchParams.get("state") : null;
  if (!state) {
    throw new Error(
      `Supabase stuurt niet door naar de inlogdienst (status ${begin.status}). Staat [auth.external.${LOKALE_DIENST}] aan in supabase/config.toml, en is de lokale Supabase daarna opnieuw gestart?`,
    );
  }
  const terugkeer = new URLSearchParams({ code: codeVoor(persoon), state });
  const terug = await fetch(`${url}/auth/v1/callback?${terugkeer.toString()}`, {
    redirect: "manual",
  });
  const naarApp = terug.headers.get("location");
  if (!naarApp) {
    throw new Error(
      `Supabase gaf na de inlogdienst geen doorverwijzing (status ${terug.status}): ${await terug.text()}`,
    );
  }
  const adres = new URL(naarApp);
  const anker = new URLSearchParams(adres.hash.replace(/^#/, ""));
  const lees = (naam: string) => anker.get(naam) ?? adres.searchParams.get(naam) ?? "";
  const access_token = anker.get("access_token");
  const refresh_token = anker.get("refresh_token");
  if (!access_token || !refresh_token) {
    return { ok: false, code: lees("error_code"), tekst: lees("error_description") };
  }
  const client = nieuweClient();
  const { error } = await client.auth.setSession({ access_token, refresh_token });
  if (error) throw new Error(`De sessie van de inlogdienst werkt niet: ${error.message}`);
  return { ok: true, sessie: await alsSessie(client) };
}

/** Als hierboven, voor waar de test een sessie verwacht. */
export async function sessieViaInlogdienst(persoon: Persoon): Promise<Sessie> {
  const uitkomst = await inloggenViaInlogdienst(persoon);
  if (!uitkomst.ok) {
    throw new Error(
      `Inloggen via de inlogdienst mislukt: ${uitkomst.code} ${uitkomst.tekst}. Draait de lokale Supabase met de config.toml van deze branch?`,
    );
  }
  return uitkomst.sessie;
}

/**
 * Een opdracht aan de lokale database als beheerder, voor wat alleen Supabase Auth zelf
 * schrijft (auth.identities). Nooit tegen een database in de cloud.
 */
function alsBeheerder(sql: string): string {
  const adres = nodig(
    "SUPABASE_DB_URL",
    import.meta.env.SUPABASE_DB_URL ?? process.env.SUPABASE_DB_URL,
  );
  if (!/@(?:127\.0\.0\.1|localhost):/.test(adres)) {
    throw new Error("SUPABASE_DB_URL wijst niet naar de lokale database.");
  }
  // De tabellen van Supabase Auth zijn van Supabase zelf; lokaal mag supabase_admin erin.
  const beheerder = new URL(adres);
  beheerder.username = "supabase_admin";
  const opties = ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql];
  const fouten: string[] = [];
  // Eerst als supabase_admin; lukt dat niet (een andere versie van de lokale Supabase), dan
  // als de gebruiker uit het adres zelf.
  for (const als of [beheerder.toString(), adres]) {
    try {
      return execFileSync("psql", [als, ...opties], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (fout) {
      fouten.push(String((fout as { stderr?: unknown }).stderr ?? "").trim());
    }
  }
  throw new Error(`De lokale database weigerde de opdracht van de test: ${fouten.join(" | ")}`);
}

const UUID = /^[0-9a-f-]{36}$/;

/**
 * Zet op de koppeling die Supabase zelf maakte bij het inloggen via de nagebootste dienst,
 * de naam van de dienst om naar `custom:cloudflare`. Zie de uitleg bovenaan dit bestand.
 * Geeft een fout als er niet precies één koppeling is: dan heeft Supabase niet gedaan wat de
 * test denkt.
 */
export function noemIdentiteitCloudflare(userId: string): void {
  if (!UUID.test(userId)) throw new Error("Ongeldige testgegevens.");
  const aantal = alsBeheerder(
    `with gewijzigd as (
       update auth.identities set provider = 'custom:cloudflare'
        where user_id = '${userId}' and provider = '${LOKALE_DIENST}'
       returning 1
     )
     select count(*) from gewijzigd`,
  );
  if (aantal !== "1") {
    throw new Error(
      `Verwachtte één koppeling met de inlogdienst op dit account, maar vond er ${aantal}.`,
    );
  }
}

export function nieuwAdres(label: string): string {
  return `rls-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@voorbeeld.nl`;
}

/** Een nieuwe persoon bij de inlogdienst. */
export function nieuwPersoon(label: string, o: { adresBevestigd: boolean }): Persoon {
  const email = nieuwAdres(label);
  return {
    sub: `dienst-${label}-${Math.random().toString(36).slice(2, 10)}`,
    email,
    ...(o.adresBevestigd ? { email_verified: true } : {}),
  };
}

/** Wacht op de eerstvolgende mail voor dit adres; aanroepen vóórdat de mail verstuurd wordt. */
export function wachtOpMail(email: string) {
  return wachtOpInlogmail({ email, mailUrl });
}

export async function verwijderAccount(id: string | undefined): Promise<void> {
  if (id) await admin.auth.admin.deleteUser(id);
}

/** Alle accounts met dit adres of zonder adres die bij deze persoon van de dienst horen. */
export async function accountsVan(persoon: Persoon): Promise<string[]> {
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new Error(`Kon de accounts niet lezen: ${error.message}`);
  return data.users
    .filter(
      (user) =>
        user.email === persoon.email ||
        user.identities?.some((identiteit) => identiteit.identity_data?.sub === persoon.sub),
    )
    .map((user) => user.id);
}
