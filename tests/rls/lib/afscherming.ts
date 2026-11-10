import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect } from "vitest";
import type { Database } from "../../../src/lib/database.types";

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
 * Deze hulp is van de template en komt met elke versie mee.
 */

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

/** Een nieuwe testgebruiker, ingelogd. Ruim hem op met `verwijderActor`. */
export async function maakActor(label: string): Promise<Actor> {
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

  return { id: data.user.id, email, client };
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
