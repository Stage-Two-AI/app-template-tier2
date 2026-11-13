import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin } from "./lib/afscherming";
import { vraagDatabase } from "./lib/database";
import { problemenKlantportaalInDatabase } from "./lib/klantportaal-poort";
import {
  inloggenMetMailcode,
  nieuwAdres,
  pauze,
  type Sessie,
  verwijderAccount,
} from "./lib/sessies";

/**
 * AANVAL ronde 2, doel 1: de guard van het klantportaal omzeilen.
 *
 * Elke test hier SLAAGT als de aanval lukt. Per constructie drie dingen, in deze volgorde:
 *
 *   1. `pnpm guard:rls` is groen op de migraties van de template, een gewone basis voor een
 *      klantportaal (de poort op `items`, een tabel `dossiers` alleen voor medewerkers) en de
 *      migratie van de aanval, met `"klantportaal": true`;
 *   2. de controle op de database zelf (tests/rls/open-policies.test.ts: de open policies en
 *      `problemenKlantportaalInDatabase`) vindt niets nadat dezelfde SQL echt is toegepast;
 *   3. een account dat alleen een mailadres heeft en niet is goedgekeurd (of een bezoeker
 *      zonder account) leest of schrijft via de echte API.
 *
 * De SQL wordt toegepast zoals een migratie: als `postgres`, met de standaardrechten van
 * Supabase. Na elke test gaat alles terug naar de stand van de template.
 */

const url = String(import.meta.env.SUPABASE_URL);
const anonKey = String(import.meta.env.SUPABASE_ANON_KEY);
const adres = String(import.meta.env.SUPABASE_DB_URL ?? process.env.SUPABASE_DB_URL);
const REPO = resolve(__dirname, "../..");
const GEHEIM = "aanval2-geheim";
/** Zonder Supabase (alleen een kale Postgres): stap 1 en 2, zonder de API. Voor het schrijven van deze tests. */
const ZONDER_API = process.env.AANVAL2_ZONDER_API === "1";

/** Een gewone start voor een klantportaal: zo zou een bouwer het na de werkwijze doen. */
const BASIS = `
create policy "items_poort" on public.items as restrictive for all to authenticated
  using (public.is_medewerker() or public.is_goedgekeurde_klant());

create table public.dossiers (
  id uuid primary key default gen_random_uuid(),
  klant text not null,
  geheim text not null
);
alter table public.dossiers enable row level security;
grant select, insert, update, delete on public.dossiers to authenticated;
create policy "dossiers_medewerker" on public.dossiers for all to authenticated
  using (public.is_medewerker()) with check (public.is_medewerker());
insert into public.dossiers (klant, geheim) values ('Jansen', '${GEHEIM}');
`;

const OPRUIMEN = `
drop view if exists public.dossiers_lijst cascade;
drop view if exists public.notities cascade;
drop schema if exists intern cascade;
drop function if exists public.dossiers_overzicht() cascade;
drop function if exists public.zoek_dossier(text) cascade;
drop function if exists public.alle_dossiers() cascade;
drop function if exists public.is_bekende_klant() cascade;
drop policy if exists "aanval2_meeluisteren" on realtime.messages;
drop table if exists public.dossiers cascade;
drop policy if exists "items_poort" on public.items;
`;

function alsMigratie(sql: string): string {
  if (!/@(?:127\.0\.0\.1|localhost):/.test(adres)) {
    throw new Error("SUPABASE_DB_URL wijst niet naar de lokale database.");
  }
  return execFileSync("psql", [adres, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

type Config = Record<string, unknown>;

/** Draait de echte `scripts/guard-rls.mjs` op de migraties van de template plus de aanval. */
function guardRls(aanval: string, extraConfig: Config = {}): { code: number | null; uit: string } {
  const map = mkdtempSync(join(tmpdir(), "aanval2-guard-"));
  try {
    mkdirSync(join(map, "supabase/migrations"), { recursive: true });
    for (const naam of readdirSync(join(REPO, "supabase/migrations"))) {
      cpSync(join(REPO, "supabase/migrations", naam), join(map, "supabase/migrations", naam));
    }
    writeFileSync(join(map, "supabase/migrations/20261201000000_basis.sql"), BASIS);
    writeFileSync(join(map, "supabase/migrations/20261202000000_aanval.sql"), aanval);
    writeFileSync(
      join(map, "stack.config.json"),
      JSON.stringify({ database: true, klantportaal: true, open_tabellen: {}, ...extraConfig }),
    );
    const r = spawnSync("node", [join(REPO, "scripts/guard-rls.mjs")], {
      cwd: map,
      encoding: "utf8",
    });
    return { code: r.status, uit: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(map, { recursive: true, force: true });
  }
}

/** Dezelfde twee controles als tests/rls/open-policies.test.ts, op de database zoals hij nu is. */
function databasecontrole(extraConfig: Config = {}): string[] {
  const open = vraagDatabase<{ tablename: string; policyname: string }>(`
    select tablename, policyname from pg_policies
     where schemaname = 'public'
       and (trim(coalesce(qual, '')) in ('true', '(true)')
         or trim(coalesce(with_check, '')) in ('true', '(true)'))`);
  return [
    ...open.map((p) => `open policy ${p.tablename}/${p.policyname}`),
    ...problemenKlantportaalInDatabase({
      poorten: (extraConfig.klantportaal_poorten ?? {}) as Record<string, string>,
      vrijeFuncties: {},
      openTabellen: {},
    }),
  ];
}

function metToken(token: string): SupabaseClient {
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

function zonderAccount(): SupabaseClient {
  return createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

/** PostgREST leest het schema na een wijziging opnieuw in; dat duurt even. */
async function totHetLukt<T>(probeer: () => Promise<T | null>, ms = 20_000): Promise<T | null> {
  const eind = Date.now() + ms;
  for (;;) {
    const uitkomst = await probeer();
    if (uitkomst !== null || Date.now() > eind) return uitkomst;
    await pauze(500);
  }
}

const bevatGeheim = (rijen: unknown): true | null =>
  JSON.stringify(rijen ?? null).includes(GEHEIM) ? true : null;

let vreemde: Sessie;
let poortfuncties = "";

beforeAll(async () => {
  // Zoals de template ze heeft gemaakt, om na de aanval terug te zetten.
  poortfuncties = alsMigratie(
    `select string_agg(pg_get_functiondef(p.oid), E';\n')
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('sessie_via_cloudflare', 'is_medewerker', 'is_goedgekeurde_klant')`,
  );
  alsMigratie(OPRUIMEN);
  alsMigratie(BASIS);
  if (!ZONDER_API) vreemde = await inloggenMetMailcode(nieuwAdres("aanval2-vreemde"));
}, 60_000);

afterAll(async () => {
  alsMigratie(`${OPRUIMEN}; ${poortfuncties}; notify pgrst, 'reload schema'`);
  await verwijderAccount(vreemde?.userId);
});

type Aanval = {
  sql: string;
  config?: Config;
  /** Geeft iets anders dan null zodra de aanval via de API is gelukt. */
  lek: () => Promise<unknown>;
};

async function speel({ sql, config = {}, lek }: Aanval): Promise<void> {
  const guard = guardRls(sql, config);
  expect(guard.code, `guard:rls hoort hier groen te zijn voor de aanval:\n${guard.uit}`).toBe(0);
  try {
    alsMigratie(`${sql}; notify pgrst, 'reload schema'`);
    expect(databasecontrole(config), "de databasecontrole ziet de aanval").toEqual([]);
    if (ZONDER_API) return;
    const gelekt = await totHetLukt(async () => (await lek()) ?? null);
    expect(gelekt, "de aanval is via de API niet gelukt").not.toBeNull();
  } finally {
    alsMigratie(
      `${OPRUIMEN}; ${poortfuncties}; ${BASIS}; notify pgrst, 'reload schema'`.replaceAll(
        ";;",
        ";",
      ),
    );
  }
}

describe.skipIf(ZONDER_API)("opzet: de controles werken, en de basis is dicht", () => {
  it("de guard is groen op de basis, rood op een policy zonder poort, en de database is dicht voor de vreemde", async () => {
    expect(guardRls("select 1;").code).toBe(0);
    const rood = guardRls(
      `create policy "dossiers_eigen" on public.dossiers for select to authenticated using (klant = 'x');`,
    );
    expect(rood.code).toBe(1);
    expect(rood.uit).toContain("Klantportaal");
    expect(databasecontrole()).toEqual([]);
    const lezen = await totHetLukt(async () => {
      const { data, error } = await metToken(vreemde.token).from("dossiers").select("*");
      return error ? null : data;
    });
    expect(lezen).toEqual([]);
    const { data: anoniem } = await zonderAccount().from("dossiers").select("*");
    expect(anoniem ?? []).toEqual([]);
  });

  it("de standaardrechten van Supabase: een nieuwe tabel of functie in public is zonder grant al voor anon en authenticated", () => {
    alsMigratie(
      "create table public.dossiers_proef (id int); create function public.dossiers_proef_f() returns int language sql as 'select 1'",
    );
    try {
      const rechten = alsMigratie(
        `select has_table_privilege('anon', 'public.dossiers_proef', 'select')::text || ',' ||
                has_table_privilege('authenticated', 'public.dossiers_proef', 'insert')::text || ',' ||
                has_function_privilege('anon', 'public.dossiers_proef_f()', 'execute')::text`,
      );
      expect(rechten).toBe("true,true,true");
    } finally {
      alsMigratie(
        "drop table public.dossiers_proef; drop function public.dossiers_proef_f(); notify pgrst, 'reload schema'",
      );
    }
  });
});

describe("AANVAL2 doel 1: guard groen, databasecontrole groen, en toch lekt het", () => {
  it("1.1 GELUKT ALS: een tabel die in een latere migratie opnieuw wordt gemaakt (drop + create) staat zonder RLS open, ook voor schrijven", async () => {
    await speel({
      sql: `
        drop table public.dossiers;
        create table public.dossiers (
          id uuid primary key default gen_random_uuid(),
          klant text not null,
          geheim text not null,
          status text not null default 'open'
        );
        insert into public.dossiers (klant, geheim) values ('Jansen', '${GEHEIM}');`,
      lek: async () => {
        const client = metToken(vreemde.token);
        const { data } = await client.from("dossiers").select("*");
        if (!bevatGeheim(data)) return null;
        const { error } = await client
          .from("dossiers")
          .insert({ klant: "vreemde", geheim: "geschreven door een vreemde" });
        return error ? null : true;
      },
    });
  });

  it("1.2 GELUKT ALS: `alter table ... disable row level security` in een latere migratie zet de tabel open", async () => {
    await speel({
      sql: "alter table public.dossiers disable row level security;",
      lek: async () =>
        bevatGeheim((await metToken(vreemde.token).from("dossiers").select("*")).data),
    });
  });

  it("1.3 GELUKT ALS: een view die de poort alleen als kolom toont (`is_medewerker() as mag_wijzigen`) gaat langs de policies heen", async () => {
    await speel({
      sql: `
        create view public.dossiers_lijst as
          select d.id, d.klant, d.geheim, public.is_medewerker() as mag_wijzigen
            from public.dossiers d;`,
      lek: async () =>
        bevatGeheim((await metToken(vreemde.token).from("dossiers_lijst").select("*")).data),
    });
  });

  it("1.4 GELUKT ALS: een security definer-functie die de poort aanroept maar het antwoord weggooit (`perform`)", async () => {
    await speel({
      sql: `
        create function public.dossiers_overzicht() returns setof public.dossiers
        language plpgsql security definer set search_path = '' as $$
        begin
          perform public.is_medewerker();
          return query select * from public.dossiers;
        end $$;`,
      lek: async () => bevatGeheim((await metToken(vreemde.token).rpc("dossiers_overzicht")).data),
    });
  });

  it("1.5 GELUKT ALS: een security definer-functie met de poort in een `or` (medewerker ziet alles, de rest zoekt op naam)", async () => {
    await speel({
      sql: `
        create function public.zoek_dossier(zoek text) returns setof public.dossiers
        language sql stable security definer set search_path = '' as $$
          select d.* from public.dossiers d
           where public.is_medewerker() or d.klant = zoek
        $$;`,
      lek: async () =>
        bevatGeheim((await metToken(vreemde.token).rpc("zoek_dossier", { zoek: "Jansen" })).data),
    });
  });

  it("1.6 GELUKT ALS: gegevens in een eigen schema zonder RLS, ontsloten met een view met security_invoker", async () => {
    await speel({
      sql: `
        create schema intern;
        create table intern.notities (id int primary key, tekst text not null);
        insert into intern.notities values (1, '${GEHEIM}');
        grant usage on schema intern to authenticated;
        grant select on intern.notities to authenticated;
        create view public.notities with (security_invoker = true) as
          select id, tekst from intern.notities;`,
      lek: async () =>
        bevatGeheim((await metToken(vreemde.token).from("notities").select("*")).data),
    });
  });

  it("1.7 GELUKT ALS: een policy `to anon` zonder poort (geen letterlijke true): leesbaar zonder account", async () => {
    await speel({
      sql: `
        create policy "dossiers_volgen" on public.dossiers for select to anon
          using (klant is not null);`,
      lek: async () => bevatGeheim((await zonderAccount().from("dossiers").select("*")).data),
    });
  });

  it("1.8 GELUKT ALS: de poort als restrictive policy `to authenticated` dekt een policy zonder `to` af, maar die geldt ook voor anon", async () => {
    await speel({
      sql: `
        create policy "dossiers_poort" on public.dossiers as restrictive for all to authenticated
          using (public.is_medewerker() or public.is_goedgekeurde_klant());
        create policy "dossiers_met_naam" on public.dossiers for select
          using (klant <> '');`,
      lek: async () => bevatGeheim((await zonderAccount().from("dossiers").select("*")).data),
    });
  });

  it("1.9 GELUKT ALS: `create or replace` van is_goedgekeurde_klant() zonder de goedkeuring: aanmelden is dan genoeg om te schrijven", async () => {
    await speel({
      sql: `
        create or replace function public.is_goedgekeurde_klant() returns boolean
        language sql stable security definer set search_path = '' as $$
          select exists (select 1 from public.klanten k where k.user_id = auth.uid())
        $$;`,
      lek: async () => {
        const client = metToken(vreemde.token);
        await client.rpc("klant_aanmelden");
        const { data, error } = await client
          .from("items")
          .insert({ owner_id: vreemde.userId, title: "aanval2: niet goedgekeurd" })
          .select("id");
        if (error || !data?.length) return null;
        await admin.from("items").delete().eq("owner_id", vreemde.userId);
        return true;
      },
    });
  });

  it("1.10 GELUKT ALS: `create or replace` van sessie_via_cloudflare() die altijd waar zegt: iedereen met een mailadres is medewerker", async () => {
    await speel({
      sql: `
        create or replace function public.sessie_via_cloudflare() returns boolean
        language sql stable security definer set search_path = '' as $$ select true $$;`,
      lek: async () => {
        const client = metToken(vreemde.token);
        const { data: medewerker } = await client.rpc("is_medewerker");
        if (medewerker !== true) return null;
        return bevatGeheim((await client.from("dossiers").select("*")).data);
      },
    });
  });

  it("1.11 GELUKT ALS: een eigen poort in klantportaal_poorten die de poort van de template wel aanroept, maar in een `or`", async () => {
    await speel({
      config: { klantportaal_poorten: { is_bekende_klant: "klanten die we kennen" } },
      sql: `
        create function public.is_bekende_klant() returns boolean
        language sql stable security definer set search_path = '' as $$
          select public.is_goedgekeurde_klant()
              or exists (select 1 from public.klanten k where k.user_id = auth.uid())
        $$;
        create policy "dossiers_bekende_klant" on public.dossiers for select to authenticated
          using (public.is_bekende_klant());`,
      lek: async () => {
        const client = metToken(vreemde.token);
        await client.rpc("klant_aanmelden");
        return bevatGeheim((await client.from("dossiers").select("*")).data);
      },
    });
  });

  it("1.12 GELUKT ALS: een security definer-functie waarvan het recht is ingetrokken bij public en authenticated, maar niet bij anon", async () => {
    await speel({
      sql: `
        create function public.alle_dossiers() returns setof public.dossiers
        language sql stable security definer set search_path = '' as $$
          select * from public.dossiers
        $$;
        revoke execute on function public.alle_dossiers() from public, authenticated;`,
      lek: async () => bevatGeheim((await zonderAccount().rpc("alle_dossiers")).data),
    });
  });
});

describe.skipIf(ZONDER_API)("AANVAL2 doel 1: buiten de tabellen om", () => {
  it("1.13 GELUKT ALS: een openbare bucket (`public = true`): het bestand is zonder account op te halen", async () => {
    const bucket = "aanval2-dossiers";
    const sql = `insert into storage.buckets (id, name, public) values ('${bucket}', '${bucket}', true);`;
    expect(guardRls(sql).code).toBe(0);
    try {
      alsMigratie(sql);
      expect(databasecontrole()).toEqual([]);
      const { error } = await admin.storage
        .from(bucket)
        .upload("jansen.txt", new Blob([GEHEIM], { type: "text/plain" }));
      expect(error).toBeNull();
      const antwoord = await fetch(`${url}/storage/v1/object/public/${bucket}/jansen.txt`);
      expect(antwoord.status).toBe(200);
      expect(await antwoord.text()).toContain(GEHEIM);
    } finally {
      await admin.storage.emptyBucket(bucket);
      await admin.storage.deleteBucket(bucket);
    }
  });

  it("1.14 GELUKT ALS: een policy `to anon` op realtime.messages laat iedereen met de openbare sleutel meeluisteren op een besloten kanaal", async () => {
    const sql = `create policy "aanval2_meeluisteren" on realtime.messages for select to anon using (realtime.topic() = 'aanval2-dossiers');`;
    const guard = guardRls(sql);
    expect(guard.code, guard.uit).toBe(0);
    const luister = async (): Promise<unknown> => {
      const client = zonderAccount();
      const kanaal = client.channel("aanval2-dossiers", { config: { private: true } });
      try {
        const ontvangen = new Promise<unknown>((klaar) => {
          kanaal.on("broadcast", { event: "nieuw" }, (bericht) => klaar(bericht.payload));
        });
        const aangesloten = await new Promise<boolean>((klaar) => {
          kanaal.subscribe((status) => {
            if (status === "SUBSCRIBED") klaar(true);
            else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") klaar(false);
          });
        });
        if (!aangesloten) return null;
        for (let keer = 0; keer < 5; keer += 1) {
          alsMigratie(
            `select realtime.send(jsonb_build_object('geheim', '${GEHEIM}'), 'nieuw', 'aanval2-dossiers', true)`,
          );
          const bericht = await Promise.race([ontvangen, pauze(2000).then(() => null)]);
          if (bericht !== null) return bericht;
        }
        return null;
      } finally {
        await client.removeChannel(kanaal);
      }
    };
    // Zonder de policy komt een bezoeker het besloten kanaal niet in.
    expect(await luister()).toBeNull();
    try {
      alsMigratie(sql);
      expect(databasecontrole()).toEqual([]);
      expect(bevatGeheim(await luister())).toBe(true);
    } finally {
      alsMigratie(`drop policy if exists "aanval2_meeluisteren" on realtime.messages`);
    }
  }, 90_000);
});
