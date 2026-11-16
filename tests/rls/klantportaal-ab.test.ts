import { describe, expect, it } from "vitest";
import { admin, controleerAfscherming, keurGoedAlsKlant } from "./lib/afscherming";
import { vraagDatabase } from "./lib/database";
import { voerUit } from "./lib/klantportaal-poort";

/**
 * De poort zegt of iemand binnen mag; de A/B-test bewijst dat klanten elkaars rijen niet zien.
 *
 * Een ruime policy achter de poort (`using (id is not null)` naast een `restrictive` poort) laat
 * een goedgekeurde klant de rijen van een andere klant zien. De databasecontrole vangt die
 * vorm (tests/rls/klantportaal-controle.test.ts), maar niet elke vorm: daarvoor is de A/B-test
 * per tabel, en die is bij een klantportaal verplicht (guard:rls-tests). Deze test bewijst op de
 * echte database dat `controleerAfscherming` het lek vangt: de tabel staat even in de database,
 * zoals na een migratie, en gaat daarna weer weg.
 *
 * Deze test is van de template en komt met elke versie mee.
 */

const heeftKlantportaal =
  vraagDatabase<{ ja: boolean }>(
    "select to_regprocedure('public.is_medewerker()') is not null as ja",
  )[0]?.ja === true;

const TABEL = "kp_proef_breed";

/** Wacht tot de API de nieuwe tabel kent (PostgREST leest het schema opnieuw na DDL). */
async function wachtOpTabel(): Promise<void> {
  for (let poging = 0; poging < 40; poging++) {
    const { error } = await admin
      .from(TABEL as never)
      .select("id")
      .limit(1);
    if (!error) return;
    await new Promise((klaar) => setTimeout(klaar, 250));
  }
  throw new Error(`De API kent ${TABEL} niet na tien seconden.`);
}

describe.runIf(heeftKlantportaal)("de A/B-test vangt wat de poort niet regelt", () => {
  it("een ruime permissive policy achter de poort: B, een goedgekeurde klant, ziet de rij van A", async () => {
    voerUit(`
      create table public.${TABEL} (
        id uuid primary key default gen_random_uuid(),
        owner_id uuid not null,
        geheim text not null
      );
      alter table public.${TABEL} enable row level security;
      grant select, insert, update, delete on public.${TABEL} to authenticated;
      revoke all on public.${TABEL} from anon;
      create policy "${TABEL}_eigen" on public.${TABEL} for all to authenticated
        using (owner_id = auth.uid()) with check (owner_id = auth.uid());
      create policy "${TABEL}_ruim" on public.${TABEL} for select to authenticated
        using (id is not null);
      create policy "${TABEL}_poort" on public.${TABEL} as restrictive for all to authenticated
        using ((select public.is_medewerker()) or (select public.is_goedgekeurde_klant()));
      notify pgrst, 'reload schema';
    `);
    try {
      await wachtOpTabel();
      const fout = await controleerAfscherming({
        tabel: TABEL as never,
        maakRijAlsA: async (a) => {
          const { data, error } = await admin
            .from(TABEL as never)
            .insert({ owner_id: a.id, geheim: "dossier van A" } as never)
            .select("id")
            .single();
          if (error) throw error;
          return (data as { id: string }).id;
        },
        // B komt door de poort: een goedgekeurde klant, ook als de schakelaar uit staat.
        voorbereidB: (b) => keurGoedAlsKlant(b),
      }).then(
        () => null,
        (f: unknown) => String(f instanceof Error ? f.message : f),
      );
      expect(fout, "de A/B-test hoort het lek te vangen").toMatch(/B ziet de rij van A/);

      // De tegenproef: zonder de ruime policy is dezelfde test groen.
      voerUit(`drop policy "${TABEL}_ruim" on public.${TABEL};`);
      await controleerAfscherming({
        tabel: TABEL as never,
        maakRijAlsA: async (a) => {
          const { data, error } = await admin
            .from(TABEL as never)
            .insert({ owner_id: a.id, geheim: "dossier van A" } as never)
            .select("id")
            .single();
          if (error) throw error;
          return (data as { id: string }).id;
        },
        voorbereidB: (b) => keurGoedAlsKlant(b),
      });
    } finally {
      voerUit(`drop table if exists public.${TABEL}; notify pgrst, 'reload schema';`);
    }
  });
});
