import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect } from "vitest";
import type { Database } from "../../../src/lib/database.types";
import { leesSchakelaar } from "./klantportaal-poort";

/**
 * De A/B-test per tabel: gebruiker A maakt een eigen rij, gebruiker B probeert hem te zien,
 * te wijzigen en te verwijderen, en mag niets. Elke tabel in `public` krijgt zo'n test, of
 * staat met een reden in `open_tabellen` in stack.config.json. `guard:rls-tests` controleert
 * dat, door te zoeken naar `controleerAfscherming({ tabel: "<naam>"` in tests/rls/.
 *
 * Gebruik:
 *
 *   it("notities: B ziet de rij van A niet", async () => {
 *     await controleerAfscherming({
 *       tabel: "notities",
 *       maakRijAlsA: async (a) => {
 *         const { data, error } = await a.client
 *           .from("notities").insert({ tekst: "van A", owner_id: a.id }).select("id").single();
 *         if (error) throw error;
 *         return data.id;
 *       },
 *     });
 *   });
 *
 * Bij een klantportaal (`"klantportaal": true` in stack.config.json) mag een account zonder
 * goedkeuring niets. Daarom is elke testgebruiker van `maakActor` (en dus A en B hierboven) dan
 * vanzelf een goedgekeurde klant: de bestaande tests van de app blijven werken zonder ze een voor
 * een aan te passen. Voor een test die juist een account zonder goedkeuring nodig heeft:
 * `maakActor("vreemde", { goedgekeurd: false })`. Een test met een eigen hulp die zelf
 * gebruikers maakt (`auth.admin.createUser`, `signInWithPassword`), roept na het maken
 * `keurGoedAlsKlant` aan. Zonder de schakelaar verandert er niets: geen extra aanroep.
 *
 * Deze hulp is van de template en komt met elke versie mee.
 */

/**
 * Staat de schakelaar van het klantportaal aan in stack.config.json van deze app? Streng gelezen,
 * zoals guard:rls: een onbekende sleutel, `"klantportaal": "true"` of een bestand dat geen JSON
 * is, is een fout in elke RLS-test, geen stil "uit". Zonder de sleutel: uit, zoals altijd.
 */
function leesKlantportaal(): boolean {
  const schakelaar = leesSchakelaar();
  if (schakelaar.fout !== undefined) {
    throw new Error(
      `De schakelaar van het klantportaal is niet te lezen, dus weten de RLS-tests niet of de poort moet gelden: ${schakelaar.fout}`,
    );
  }
  return schakelaar.aan === true;
}

export const KLANTPORTAAL = leesKlantportaal();

function nodig(naam: string, waarde: string | undefined): string {
  if (!waarde) {
    throw new Error(
      `${naam} ontbreekt. Draai \`pnpm db:start\` en daarna \`pnpm env:local\` voordat je de RLS-tests draait.`,
    );
  }
  return waarde;
}

const url = nodig("SUPABASE_URL", import.meta.env.SUPABASE_URL);
const anonKey = nodig("SUPABASE_ANON_KEY", import.meta.env.SUPABASE_ANON_KEY);
const serviceRoleKey = nodig(
  "SUPABASE_SERVICE_ROLE_KEY",
  import.meta.env.SUPABASE_SERVICE_ROLE_KEY,
);

/** Gaat langs alle beveiliging heen. Alleen voor het klaarzetten en nakijken in de test. */
export const admin = createClient<Database>(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export type Actor = {
  id: string;
  email: string;
  client: SupabaseClient<Database>;
};

/**
 * Maakt van een testaccount een goedgekeurde klant van het klantportaal. Ongetypeerd: in een app
 * zonder klantportaal kennen de databasetypes de tabel `klanten` niet, en dit bestand moet daar
 * ook de typecontrole halen.
 */
export async function keurGoedAlsKlant(actor: Pick<Actor, "id" | "email">): Promise<void> {
  const alsAdmin = admin as unknown as SupabaseClient;
  const { error } = await alsAdmin
    .from("klanten")
    .upsert({ user_id: actor.id, e_mail: actor.email, goedgekeurd: true });
  if (error) throw new Error(`Goedkeuren als klant mislukt: ${error.message}`);
}

/**
 * Een nieuwe testgebruiker, ingelogd. Ruim hem op met `verwijderActor`.
 *
 * `goedgekeurd`: is het account een goedgekeurde klant van het klantportaal? Standaard ja als
 * de schakelaar `"klantportaal": true` aan staat, anders nee (en dan gebeurt er niets extra).
 * Met `false` heeft het account geen regel in `klanten`: aangemeld noch goedgekeurd.
 */
export async function maakActor(
  label: string,
  opties: { goedgekeurd?: boolean } = {},
): Promise<Actor> {
  const email = `rls-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@voorbeeld.nl`;
  const password = "rls-test-wachtwoord-123";

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`Kon testgebruiker niet aanmaken: ${error?.message}`);

  const client = createClient<Database>(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const inlog = await client.auth.signInWithPassword({ email, password });
  if (inlog.error) throw new Error(`Kon niet inloggen als testgebruiker: ${inlog.error.message}`);

  const actor = { id: data.user.id, email, client };
  if (opties.goedgekeurd ?? KLANTPORTAAL) await keurGoedAlsKlant(actor);
  return actor;
}

export async function verwijderActor(actor: Actor | undefined): Promise<void> {
  if (actor) await admin.auth.admin.deleteUser(actor.id);
}

/** Een uitgelogde bezoeker: alleen de openbare sleutel. */
export function anoniem(): SupabaseClient<Database> {
  return createClient<Database>(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

type Tabel = keyof Database["public"]["Tables"] & string;

/** Een fout die betekent "dit mag je niet": dat is ook afscherming. */
function geweigerd(fout: { code?: string } | null): boolean {
  return fout?.code === "42501";
}

export async function controleerAfscherming(o: {
  tabel: Tabel;
  /** A maakt een eigen rij en geeft de sleutel (meestal `id`) terug. */
  maakRijAlsA: (a: Actor) => Promise<string | number>;
  /** Optioneel: zet B in de rol of organisatie die de app vraagt, maar níet die van A. */
  voorbereidB?: (b: Actor) => Promise<void>;
  /** De kolom met de sleutel. Standaard `id`. */
  sleutel?: string;
}): Promise<void> {
  const sleutel = o.sleutel ?? "id";
  const a = await maakActor("a");
  const b = await maakActor("b");
  try {
    await o.voorbereidB?.(b);
    const id = await o.maakRijAlsA(a);
    // Ongetypeerd: de hulp werkt voor elke tabel, de kolommen verschillen per tabel.
    const alsB = b.client as unknown as SupabaseClient;
    const alsAdmin = admin as unknown as SupabaseClient;
    const bestaat = async () => {
      const { data, error } = await alsAdmin.from(o.tabel).select(sleutel).eq(sleutel, id);
      if (error) throw new Error(`${o.tabel}: kon de rij van A niet nakijken: ${error.message}`);
      return (data ?? []).length === 1;
    };
    expect(await bestaat(), `${o.tabel}: de rij van A staat er niet`).toBe(true);

    const zien = await alsB.from(o.tabel).select(sleutel).eq(sleutel, id);
    if (!geweigerd(zien.error)) {
      expect(zien.error, `${o.tabel}: lezen als B gaf een onverwachte fout`).toBeNull();
      expect(zien.data, `${o.tabel}: B ziet de rij van A`).toEqual([]);
    }

    // De sleutel op zichzelf zetten verandert niets, maar is wel een echte wijziging.
    const wijzig = await alsB
      .from(o.tabel)
      .update({ [sleutel]: id })
      .eq(sleutel, id)
      .select(sleutel);
    if (!geweigerd(wijzig.error)) {
      expect(wijzig.error, `${o.tabel}: wijzigen als B gaf een onverwachte fout`).toBeNull();
      expect(wijzig.data, `${o.tabel}: B wijzigt de rij van A`).toEqual([]);
    }

    const weg = await alsB.from(o.tabel).delete().eq(sleutel, id).select(sleutel);
    if (!geweigerd(weg.error)) {
      expect(weg.error, `${o.tabel}: verwijderen als B gaf een onverwachte fout`).toBeNull();
      expect(weg.data, `${o.tabel}: B verwijdert de rij van A`).toEqual([]);
    }
    expect(await bestaat(), `${o.tabel}: de rij van A is weg na een poging van B`).toBe(true);

    const bezoeker = anoniem() as unknown as SupabaseClient;
    const open = await bezoeker.from(o.tabel).select(sleutel).eq(sleutel, id);
    if (!geweigerd(open.error)) {
      expect(open.data ?? [], `${o.tabel}: een uitgelogde bezoeker ziet de rij van A`).toEqual([]);
    }
  } finally {
    await verwijderActor(a);
    await verwijderActor(b);
  }
}
