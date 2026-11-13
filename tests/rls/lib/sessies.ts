import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../../src/lib/database.types";
import { wachtOpInlogmail } from "../../lib/mailvanger";
import { admin } from "./afscherming";

/**
 * Sessies voor de tests van het klantportaal (tests/rls/klantportaal.test.ts): echt
 * inloggen met een code per mail, en een sessie zoals Cloudflare die geeft.
 *
 * Lokaal is er geen Cloudflare. Een sessie via Cloudflare wordt daarom nagemaakt op de enige
 * plek waar het verschil zit: Supabase Auth schrijft bij elke sessie op hoe er is ingelogd
 * (de tabel auth.mfa_amr_claims) en zet dat bij het verversen in het token. De test zet daar
 * `oauth` neer, precies wat Supabase zelf doet na een terugkeer van Cloudflare, en laat
 * Supabase daarna zelf een nieuw token uitgeven. Het token is dus echt en echt ondertekend;
 * alleen het inloggen bij Cloudflare is overgeslagen. Dat kan alleen wie de database zelf
 * beheert. Een klant kan het niet: daar gaat de test over.
 */

function nodig(naam: string, waarde: string | undefined): string {
  if (!waarde) throw new Error(`${naam} ontbreekt. Draai \`pnpm db:start\` en \`pnpm env:local\`.`);
  return waarde;
}

const url = nodig("SUPABASE_URL", import.meta.env.SUPABASE_URL);
const anonKey = nodig("SUPABASE_ANON_KEY", import.meta.env.SUPABASE_ANON_KEY);
const mailUrl: string | undefined = import.meta.env.SUPABASE_MAIL_URL;

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
  const { error } = await client.auth.verifyOtp({ email, token: code, type: "email" });
  if (error) throw new Error(`Inloggen met de code mislukt: ${error.message}`);
  return alsSessie(client);
}

/**
 * Een opdracht aan de lokale database als beheerder, voor wat alleen Supabase Auth zelf
 * schrijft (auth.identities, auth.mfa_amr_claims). Nooit tegen een database in de cloud.
 */
function alsBeheerder(sql: string): void {
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
  const opties = ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql];
  try {
    execFileSync("psql", [beheerder.toString(), ...opties], { stdio: "pipe" });
  } catch {
    execFileSync("psql", [adres, ...opties], { stdio: "pipe" });
  }
}

const UUID = /^[0-9a-f-]{36}$/;
const ADRES = /^[a-z0-9._+-]+@[a-z0-9.-]+$/;

/**
 * Hangt een Cloudflare-identiteit aan een account, zoals Supabase doet bij de eerste inlog
 * via Cloudflare.
 */
export function geefCloudflareIdentiteit(userId: string, email: string): void {
  if (!UUID.test(userId) || !ADRES.test(email)) throw new Error("Ongeldige testgegevens.");
  alsBeheerder(
    `insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
     values ('cf-' || '${userId}', '${userId}', jsonb_build_object('sub', 'cf-' || '${userId}', 'email', '${email}', 'email_verified', true), 'custom:cloudflare', now(), now(), now())
     on conflict do nothing`,
  );
}

/** Hangt een andere inlogdienst aan een account. Voor de test dat de functie dan nee zegt. */
export function geefAndereIdentiteit(userId: string, provider: "google" | "azure"): void {
  if (!UUID.test(userId)) throw new Error("Ongeldige testgegevens.");
  alsBeheerder(
    `insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
     values ('${provider}-' || '${userId}', '${userId}', '{}'::jsonb, '${provider}', now(), now(), now())
     on conflict do nothing`,
  );
}

/**
 * Maakt van een bestaande sessie een sessie "via Cloudflare": zet in de administratie van
 * Supabase Auth dat deze sessie met `oauth` is begonnen en laat Supabase een nieuw token
 * uitgeven. Zie de uitleg bovenaan dit bestand.
 */
export async function maakCloudflareSessie(sessie: Sessie): Promise<Sessie> {
  if (!UUID.test(sessie.sessieId)) throw new Error("Ongeldige sessie.");
  alsBeheerder(
    `update auth.mfa_amr_claims set authentication_method = 'oauth' where session_id = '${sessie.sessieId}'`,
  );
  const { error } = await sessie.client.auth.refreshSession();
  if (error) throw new Error(`Token verversen mislukt: ${error.message}`);
  return alsSessie(sessie.client);
}

/** Een account zonder wachtwoord, zoals een medewerker die alleen via Cloudflare inlogt. */
export async function maakAccount(label: string): Promise<{ id: string; email: string }> {
  const email = `rls-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@voorbeeld.nl`;
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw new Error(`Kon account niet aanmaken: ${error?.message}`);
  return { id: data.user.id, email };
}

export function nieuwAdres(label: string): string {
  return `rls-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@voorbeeld.nl`;
}

export async function verwijderAccount(id: string | undefined): Promise<void> {
  if (id) await admin.auth.admin.deleteUser(id);
}
