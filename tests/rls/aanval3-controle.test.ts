import { describe, expect, it } from "vitest";
import { beoordeel, leesModel } from "./lib/klantportaal-poort";

/**
 * AANVAL 3 - de controle zelf op de proef: wat keurt ze (niet) af. Elke zaak zet iets in een
 * transactie die wordt teruggedraaid, en kijkt wat `beoordeelDatabase` ervan vindt. Groen (geen
 * NIEUW probleem) terwijl het gevaarlijk is = een gat; rood = de grens houdt.
 *
 * Deze tests draaien zonder de schakelaar; ze roepen de controle rechtstreeks aan.
 */

/** Een probleem dat er door `voor` bij komt (niet al in de schone database stond). */
function nieuweProblemen(voor: string, config = {}, alsBeheerder = ""): string[] {
  const schoon = beoordeel(leesModel(), config);
  const na = beoordeel(leesModel(voor, alsBeheerder), config);
  return na.filter((p) => !schoon.includes(p));
}

function lukt(voor: string, alsBeheerder = ""): boolean {
  try {
    leesModel(voor, alsBeheerder);
    return true;
  } catch {
    return false;
  }
}

describe("doel 2: de hash van de basisfuncties omzeilen", () => {
  // 2.1 Een tweede overload van is_goedgekeurde_klant: de controle slaat de naam over, de
  // hash-controle kijkt alleen naar de variant zonder argumenten. De overload is security definer,
  // owner postgres, maar blijft onzichtbaar voor de controle.
  it("2.1 overload van is_goedgekeurde_klant(...) blijft onzichtbaar (lek)", () => {
    const nieuw = nieuweProblemen(
      `create function public.is_goedgekeurde_klant(markeer boolean)
         returns boolean language sql security definer set search_path = '' as $fn$
           insert into public.klanten (user_id, e_mail, goedgekeurd)
           values (auth.uid(), '', markeer) on conflict (user_id) do update set goedgekeurd = markeer
           returning markeer
         $fn$`,
    );
    expect(nieuw, "de overload hoort een probleem op te leveren maar doet dat niet").toEqual([]);
  });

  // 2.2 Het zoekpad van een basisfunctie veranderen WORDT gezien: proconfig zit in de hash-velden.
  // Dit toont de grens.
  it("2.2 search_path van is_medewerker veranderen wordt afgekeurd (grens)", () => {
    const nieuw = nieuweProblemen(
      "alter function public.is_medewerker() set search_path = 'public'",
    );
    expect(
      nieuw.some((p) => /is_medewerker\(\) is gewijzigd.*zoekpad/.test(p)),
      "het gewijzigde zoekpad hoort rood te zijn",
    ).toBe(true);
  });

  // 2.3 Kan een gewone migratie (als postgres) auth.uid() herschrijven? Dan verandert het gedrag
  // van is_medewerker terwijl de hash gelijk blijft - en de controle hasht auth.uid() niet. Lukt
  // het alleen als supabase_admin, dan is het buiten bereik van een app.
  it("2.3 auth.uid() herschrijven als postgres", () => {
    const alsPostgres = lukt(
      "create or replace function auth.uid() returns uuid language sql stable as $fn$ select '00000000-0000-0000-0000-000000000000'::uuid $fn$",
    );
    // We leggen de uitkomst vast; herschrijven als postgres hoort NIET te kunnen.
    expect(alsPostgres, "postgres kon auth.uid() herschrijven - dan is de keten te breken").toBe(
      false,
    );
  });
});

describe("doel 3: de lijsten - leest de databasecontrole de reden?", () => {
  // 3.1 Een lege reden in klantportaal_openbaar: de databasecontrole kijkt alleen naar de SLEUTELS
  // (opLijst), nooit naar de reden. Een tabel met een policy `to anon` en een reden van één spatie
  // gaat door de databasecontrole. Alleen guard:rls (de snelle hulp) keurt de lege reden af.
  it("3.1 lege reden opent de tabel voor anon in de databasecontrole (gat in de grens)", () => {
    const nieuw = nieuweProblemen(
      `create table public.kp_av_open (id int primary key, tekst text);
       alter table public.kp_av_open enable row level security;
       grant select on public.kp_av_open to anon;
       create policy "kp_av_open_anon" on public.kp_av_open for select to anon using (true)`,
      { openbaar: { kp_av_open: " " } },
    );
    // Met een (lege) reden in openbaar zwijgt de databasecontrole over de anon-policy.
    expect(
      nieuw.some((p) => /kp_av_open.*anon|bezoekers zonder account/.test(p)),
      "de databasecontrole hoort de lege reden niet te vertrouwen, maar doet dat wel",
    ).toBe(false);
  });
});
