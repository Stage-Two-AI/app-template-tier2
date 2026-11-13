import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import {
  admin,
  anoniem,
  keurGoedAlsKlant,
  maakActor,
  verwijderActor,
  type Actor,
} from "./lib/afscherming";
import { problemenKlantportaalInDatabase } from "./lib/klantportaal-poort";

/**
 * AANVAL 3 - de poort omzeild terwijl de databasecontrole groen is.
 *
 * Elke test hier: zet iets in de ECHTE (lokale, in CI: lokale Supabase) database dat de
 * databasecontrole (scripts/lib/klantportaal-database.mjs) NIET afkeurt, en laat daarna een
 * niet-goedgekeurd of goedgekeurd-maar-andermans account via de API lezen of schrijven wat het
 * niet zou mogen. Lukt dat, dan is de poort omzeild terwijl alles groen staat.
 *
 * Dit is een aanvalstest; hij hoort niet in een uitgave. De controle moet rood kleuren op wat
 * hier gebeurt; doet ze dat niet, dan is dat het gat.
 */

const dbUrl = (import.meta.env.SUPABASE_DB_URL ?? process.env.SUPABASE_DB_URL) as string;

/** Een opdracht (DDL) die blijft staan (geen rollback), zoals een migratie hem achterlaat. */
function sql(opdracht: string): void {
  if (!/@(?:127\.0\.0\.1|localhost):/.test(dbUrl)) throw new Error("alleen lokaal");
  execFileSync("psql", [dbUrl, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", opdracht], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function nieuweClient(token?: string): SupabaseClient {
  const url = import.meta.env.SUPABASE_URL as string;
  const anon = import.meta.env.SUPABASE_ANON_KEY as string;
  return createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
    ...(token ? { global: { headers: { Authorization: `Bearer ${token}` } } } : {}),
  });
}

const opruimen: Array<() => void | Promise<void>> = [];
afterAll(async () => {
  for (const f of opruimen.reverse()) {
    try {
      await f();
    } catch {
      /* laat de rest opruimen */
    }
  }
});

describe("doel 1: databasecontrole groen, toch een lek", () => {
  // 1.1 Een overload van een basisfunctie. De controle slaat ELKE functie public.is_medewerker
  // over (de naam staat in BASISFUNCTIES), ongeacht de argumenten; de hash-controle kijkt alleen
  // naar de variant zonder argumenten. Zo blijft een tweede, kwaadaardige is_medewerker(...)
  // volledig buiten beeld. Owner = postgres, security definer: hij gaat langs de RLS en de revoke
  // op public.klanten heen. Een niet-goedgekeurd account keurt zo zichzelf goed.
  it("1.1 overload van is_medewerker() keurt een vreemde zelf goed (schrijven)", async () => {
    sql(`create function public.is_medewerker(target uuid) returns boolean
         language sql security definer set search_path = '' as $fn$
           insert into public.klanten (user_id, e_mail, goedgekeurd)
           values (coalesce(auth.uid(), target), 'ingebroken@voorbeeld.nl', true)
           on conflict (user_id) do update set goedgekeurd = true
           returning true
         $fn$;`);
    opruimen.push(() => sql("drop function if exists public.is_medewerker(uuid)"));

    // De databasecontrole zwijgt over de overload (ze slaat de naam over).
    const problemen = problemenKlantportaalInDatabase({});
    expect(
      problemen.filter((p) => /is_medewerker/.test(p)),
      "de controle hoort de overload af te keuren",
    ).toEqual([]);

    const vreemde = await maakActor("overload-vreemde", { goedgekeurd: false });
    opruimen.push(() => verwijderActor(vreemde));

    // Vooraf: geen goedgekeurde klant.
    const voor = await admin
      .from("klanten" as never)
      .select("goedgekeurd")
      .eq("user_id", vreemde.id as never);
    expect((voor.data ?? []).length, "vreemde heeft nog geen rij").toBe(0);

    // De aanval via de API: roep de overload aan.
    const rpc = await vreemde.client.rpc("is_medewerker" as never, { target: vreemde.id } as never);
    expect(rpc.error, `rpc fout: ${rpc.error?.message}`).toBeNull();

    const na = await admin
      .from("klanten" as never)
      .select("goedgekeurd")
      .eq("user_id", vreemde.id as never)
      .single();
    expect(
      (na.data as { goedgekeurd?: boolean } | null)?.goedgekeurd,
      "de vreemde heeft zichzelf goedgekeurd terwijl de controle groen was",
    ).toBe(true);
  });

  // 1.2 Een security definer-functie op de vrije lijst (klantportaal_vrije_functies) wordt niet
  // nagekeken: "hij roept een poort aan" wordt niet geëist, laat staan wat hij teruggeeft. Een
  // onschuldige reden volstaat. De functie leest hier de hele tabel klanten.
  it("1.2 vrije functie met onschuldige reden lekt de hele tabel klanten (lezen)", async () => {
    sql(`create function public.kp_aanval_storing()
           returns table (user_id uuid, e_mail text, goedgekeurd boolean)
           language sql security definer set search_path = '' as $fn$
             select user_id, e_mail, goedgekeurd from public.klanten
           $fn$;
         revoke execute on function public.kp_aanval_storing() from anon;`);
    opruimen.push(() => sql("drop function if exists public.kp_aanval_storing()"));

    // Een echte klant als slachtoffer in de tabel.
    const slachtoffer = await maakActor("storing-slachtoffer", { goedgekeurd: true });
    opruimen.push(() => verwijderActor(slachtoffer));

    const problemen = problemenKlantportaalInDatabase({
      vrijeFuncties: { kp_aanval_storing: "mag iedereen met een account een storing melden" },
    });
    expect(
      problemen.filter((p) => /kp_aanval_storing/.test(p)),
      "de controle laat een vrije functie ongezien door",
    ).toEqual([]);

    const vreemde = await maakActor("storing-vreemde", { goedgekeurd: false });
    opruimen.push(() => verwijderActor(vreemde));

    const rpc = await vreemde.client.rpc("kp_aanval_storing" as never);
    expect(rpc.error, `rpc fout: ${rpc.error?.message}`).toBeNull();
    const rijen = (rpc.data ?? []) as Array<{ e_mail: string }>;
    expect(
      rijen.some((r) => r.e_mail === slachtoffer.email),
      "een niet-goedgekeurd account las het adres van een andere klant",
    ).toBe(true);
  });

  // 1.3 (controle houdt stand) Dezelfde definer-functie, maar NIET op de vrije lijst: de controle
  // hoort hem af te keuren. Dit toont de grens: zonder lijst is het rood.
  it("1.3 dezelfde functie zonder vrije lijst wordt wel afgekeurd (grens)", async () => {
    sql(`create function public.kp_aanval_open()
           returns table (user_id uuid, e_mail text)
           language sql security definer set search_path = '' as $fn$
             select user_id, e_mail from public.klanten
           $fn$;
         revoke execute on function public.kp_aanval_open() from anon;`);
    opruimen.push(() => sql("drop function if exists public.kp_aanval_open()"));

    const problemen = problemenKlantportaalInDatabase({});
    expect(
      problemen.some((p) => /kp_aanval_open\(\): security definer/.test(p)),
      "de controle hoort een niet-vermelde definer-functie af te keuren",
    ).toBe(true);
  });
});

describe("doel 4: een bouwer volgt de route en lekt toch (per-rij lek dat de poort niet ziet)", () => {
  // De databasecontrole laat elke PERMISSIVE policy door zodra een RESTRICTIVE poort het commando
  // dekt ("gedekt"). open-policies.test.ts vangt alleen de LETTERLIJKE `true`. Een permissive
  // policy die feitelijk alle rijen teruggeeft maar niet letterlijk `true` is (hier: `id is not
  // null`), glipt door beide. Een goedgekeurde klant ziet dan de rijen van een andere klant.
  it("4.1 permissive 'id is not null' + restrictive poort: klant B ziet de rij van klant A", async () => {
    sql(`create table public.kp_aanval_dossiers (
           id uuid primary key default gen_random_uuid(),
           owner_id uuid not null default auth.uid(),
           geheim text not null
         );
         alter table public.kp_aanval_dossiers enable row level security;
         grant select, insert on public.kp_aanval_dossiers to authenticated;
         create policy "kp_av_eigen_insert" on public.kp_aanval_dossiers for insert to authenticated
           with check (owner_id = auth.uid());
         create policy "kp_av_breed" on public.kp_aanval_dossiers for select to authenticated
           using (id is not null);
         create policy "kp_av_poort" on public.kp_aanval_dossiers as restrictive for all to authenticated
           using ((select public.is_medewerker()) or (select public.is_goedgekeurde_klant()))
           with check ((select public.is_medewerker()) or (select public.is_goedgekeurde_klant()));`);
    opruimen.push(() => sql("drop table if exists public.kp_aanval_dossiers"));

    const problemen = problemenKlantportaalInDatabase({});
    expect(
      problemen.filter((p) => /kp_aanval_dossiers/.test(p)),
      "de controle ziet het per-rij lek niet (buiten scope)",
    ).toEqual([]);

    const a = await maakActor("dossier-a", { goedgekeurd: true });
    const b = await maakActor("dossier-b", { goedgekeurd: true });
    opruimen.push(() => verwijderActor(a));
    opruimen.push(() => verwijderActor(b));

    const maak = await a.client
      .from("kp_aanval_dossiers" as never)
      .insert({ geheim: "dossier van A" } as never)
      .select("id")
      .single();
    expect(maak.error, `A kon geen rij maken: ${maak.error?.message}`).toBeNull();

    const zien = await b.client.from("kp_aanval_dossiers" as never).select("geheim");
    const gezien = ((zien.data ?? []) as Array<{ geheim: string }>).map((r) => r.geheim);
    expect(gezien, "goedgekeurde klant B ziet het dossier van klant A").toContain("dossier van A");
  });
});
