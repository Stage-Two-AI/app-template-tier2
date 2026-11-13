// TIJDELIJK, hoort bij .github/workflows/tijdelijk-e2e.yml en gaat weg voor de merge.
//
// Haalt per keer één bescherming uit de migratie van het klantportaal, bouwt de lokale
// database opnieuw op en draait de RLS-tests. Blijven die groen, dan bewaakt geen test die
// bescherming. Overgenomen van de aanvaller van ronde 1 (tests/aanval-mutaties.mjs op de
// branch aanval/43-inlog), bijgewerkt voor de migratie zoals hij nu is, met mutaties erbij
// voor wat er in ronde 3 bij kwam. Uitvoer: een tabel in de stapsamenvatting.
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const MIGRATIE = "supabase/migrations/20261114100000_klantportaal.sql";
const origineel = readFileSync(MIGRATIE, "utf8");
const SESSIE = `exists (
       select 1
         from auth.sessions s
        where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid
          and s.user_id = auth.uid()
     )`;

/** [naam, wat er wegvalt, zoek, vervang] */
const MUTATIES = [
  ["m0-geen", "niets (de test moet groen zijn)", null, null],
  [
    "m1-amr-weg",
    "de amr-controle: elke inlogmanier telt",
    "where stap ->> 'method' = 'oauth'",
    "where true",
  ],
  [
    "m1b-amr-niet-otp",
    "de amr-controle verzwakt: alles behalve otp telt",
    "where stap ->> 'method' = 'oauth'",
    "where stap ->> 'method' <> 'otp'",
  ],
  [
    "m2-12uur-weg",
    "de twaalf uur",
    "and s.created_at > now() - instelling.medewerkersessie_geldig",
    "",
  ],
  [
    "m2b-12uur-vanaf-verversen",
    "de twaalf uur tellen vanaf het laatste verversen",
    "and s.created_at > now()",
    "and coalesce(s.refreshed_at at time zone 'utc', s.created_at) > now()",
  ],
  [
    "m3-sessie-van-token-weg",
    "de sessie hoeft niet die van dit token te zijn (elke sessie van het account telt)",
    "where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid\n         and s.user_id = auth.uid()\n         and s.created_at",
    "where s.user_id = auth.uid()\n         and s.created_at",
  ],
  [
    "m3b-sessie-eigenaar-weg",
    "de sessie hoeft niet van dit account te zijn",
    "and s.user_id = auth.uid()\n         and s.created_at",
    "and s.created_at",
  ],
  [
    "m3c-sessie-bestaat-weg",
    "de sessie hoeft niet meer te bestaan (uitloggen helpt niet)",
    "from auth.sessions s, instelling\n       where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid\n         and s.user_id = auth.uid()\n         and s.created_at > now() - instelling.medewerkersessie_geldig",
    "from instelling\n       where to_timestamp((auth.jwt() -> 'amr' -> 0 ->> 'timestamp')::bigint) > now() - instelling.medewerkersessie_geldig",
  ],
  [
    "m4-cloudflare-identiteit-weg",
    "het account hoeft geen Cloudflare-identiteit te hebben",
    "and i.provider = 'custom:cloudflare'\n    )\n    and not exists",
    "and true\n    )\n    and not exists",
  ],
  [
    "m5-tweede-dienst-mag",
    "een tweede inlogdienst aan het account mag",
    "and i.provider not in ('custom:cloudflare', 'email')",
    "and false",
  ],
  [
    "m6-policy-select-open",
    "de select-policy: iedereen ziet alle klanten",
    "for select\n  to authenticated\n  using ((select public.is_medewerker()));",
    "for select\n  to authenticated\n  using (true);",
  ],
  [
    "m6b-policy-select-eigen",
    "de select-policy: een klant ziet zijn eigen regel",
    "for select\n  to authenticated\n  using ((select public.is_medewerker()));",
    "for select\n  to authenticated\n  using ((select auth.uid()) = user_id or (select public.is_medewerker()));",
  ],
  [
    "m7-policy-update-eigen",
    "de update-policy: een klant wijzigt zijn eigen regel",
    "using ((select public.is_medewerker()))\n  with check ((select public.is_medewerker()));",
    "using ((select auth.uid()) = user_id or (select public.is_medewerker()))\n  with check (true);",
  ],
  [
    "m7b-policy-update-withcheck",
    "alleen de with check van de update-policy",
    "with check ((select public.is_medewerker()));",
    "with check (true);",
  ],
  [
    "m8-grant-alle-kolommen",
    "de smalle grant: alle kolommen wijzigbaar",
    "grant update (goedgekeurd) on public.klanten to authenticated;",
    "grant update on public.klanten to authenticated;",
  ],
  [
    "m8b-grant-insert-delete",
    "klanten mogen zelf een regel maken of weghalen (grant + policy op eigen regel)",
    "grant select on public.klanten to authenticated;",
    "grant select, insert, delete on public.klanten to authenticated;\ncreate policy x_ins on public.klanten for insert to authenticated with check ((select auth.uid()) = user_id);\ncreate policy x_del on public.klanten for delete to authenticated using ((select auth.uid()) = user_id);",
  ],
  [
    "m8c-grant-insert",
    "klanten mogen zelf een regel maken (grant + policy op eigen regel)",
    "grant select on public.klanten to authenticated;",
    "grant select, insert on public.klanten to authenticated;\ncreate policy x_ins on public.klanten for insert to authenticated with check ((select auth.uid()) = user_id);",
  ],
  [
    "m8d-grant-delete",
    "klanten mogen hun eigen regel weghalen (grant + policy op eigen regel)",
    "grant select on public.klanten to authenticated;",
    "grant select, delete on public.klanten to authenticated;\ncreate policy x_del on public.klanten for delete to authenticated using ((select auth.uid()) = user_id);",
  ],
  [
    "m9-goedkeuring-telt-niet",
    "is_goedgekeurde_klant kijkt niet naar goedgekeurd",
    "and k.goedgekeurd\n",
    "\n",
  ],
  [
    "m10-anon-mag-functies",
    "de revoke voor bezoekers zonder inlog op drie van de vier functies",
    "revoke all on function public.sessie_via_cloudflare() from public, anon, authenticated;\n",
    "",
  ],
  [
    "m10b-anon-mag-aanmelden",
    "de revoke op klant_aanmelden",
    "revoke all on function public.klant_aanmelden() from public, anon, authenticated;\n",
    "",
  ],
  [
    "m10c-anon-mag-goedgekeurd",
    "de revoke op is_goedgekeurde_klant",
    "revoke all on function public.is_goedgekeurde_klant() from public, anon, authenticated;\n",
    "",
  ],
  [
    "m10d-anon-mag-medewerker",
    "de revoke op is_medewerker",
    "revoke all on function public.is_medewerker() from public, anon, authenticated;\n",
    "",
  ],
  [
    "m11-adres-uit-token",
    "klant_aanmelden neemt het adres uit user_metadata van het token als dat er is",
    "select u.id, u.email\n",
    "select u.id, coalesce(auth.jwt() -> 'user_metadata' ->> 'e_mail', u.email)\n",
  ],
  [
    "m12-rls-uit",
    "RLS op klanten staat uit",
    "alter table public.klanten enable row level security;",
    "-- rls uit",
  ],
  [
    "m13-aanmelden-zonder-sessie",
    "klant_aanmelden kijkt niet of de sessie nog bestaat",
    `and u.email is not null\n     and ${SESSIE}`,
    "and u.email is not null",
  ],
  [
    "m14-goedgekeurd-zonder-sessie",
    "is_goedgekeurde_klant kijkt niet of de sessie nog bestaat",
    "and k.goedgekeurd\n  )\n  and exists (\n    select 1\n      from auth.sessions s\n     where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid\n       and s.user_id = auth.uid()\n  )",
    "and k.goedgekeurd\n  )",
  ],
  [
    "m15-adres-sessies-blijven",
    "na een adreswijziging blijven de sessies bestaan",
    "delete from auth.sessions where user_id = new.id;",
    "",
  ],
  [
    "m16-adres-goedkeuring-blijft",
    "na een adreswijziging blijft de goedkeuring staan",
    "set e_mail = coalesce(new.email, ''),\n         goedgekeurd = false",
    "set e_mail = coalesce(new.email, '')",
  ],
  [
    "m17-adres-loopt-niet-mee",
    "na een adreswijziging blijft het oude adres op de lijst",
    "set e_mail = coalesce(new.email, ''),\n         goedgekeurd = false",
    "set goedgekeurd = false",
  ],
  [
    "m18-geen-trigger",
    "de trigger op een adreswijziging ontbreekt",
    "create trigger klant_adres_gewijzigd\n  after update on auth.users\n  for each row\n  when (old.email is distinct from new.email)\n  execute function public.klant_adres_gewijzigd();",
    "",
  ],
];

const alleen = process.argv.slice(2);
const regels = ["| mutatie | wat valt weg | RLS-tests | conclusie |", "|---|---|---|---|"];
let kapot = false;
try {
  for (const [naam, wat, zoek, vervang] of MUTATIES) {
    if (alleen.length > 0 && !alleen.includes(naam)) continue;
    let sql = origineel;
    if (zoek !== null) {
      if (!origineel.includes(zoek)) {
        regels.push(`| ${naam} | ${wat} | - | MUTATIE PAST NIET (zoektekst niet gevonden) |`);
        kapot = true;
        continue;
      }
      sql = origineel.replace(zoek, vervang);
    }
    if (process.env.DROOG) {
      regels.push(`| ${naam} | ${wat} | - | past |`);
      continue;
    }
    writeFileSync(MIGRATIE, sql);
    const reset = spawnSync("pnpm", ["exec", "supabase", "db", "reset"], { encoding: "utf8" });
    if (reset.status !== 0) {
      regels.push(
        `| ${naam} | ${wat} | - | database bouwt niet: ${String(reset.stderr).trim().split("\n").pop()} |`,
      );
      kapot = true;
      continue;
    }
    const test = spawnSync("pnpm", ["exec", "vitest", "run", "--config", "vitest.rls.config.ts"], {
      encoding: "utf8",
    });
    const uit = `${test.stdout}\n${test.stderr}`;
    const gefaald = [...uit.matchAll(/^\s*(?:×|✗)\s+(.*)$/gm)].map((t) => t[1].trim());
    const groen = test.status === 0;
    console.log(`=== ${naam}: ${groen ? "GROEN" : "ROOD"}\n${gefaald.slice(0, 12).join("\n")}`);
    if (zoek === null ? !groen : groen) kapot = true;
    const conclusie =
      zoek === null
        ? groen
          ? "uitgangspunt klopt"
          : "UITGANGSPUNT ROOD"
        : groen
          ? "**ONBEWAAKT**: de tests blijven groen"
          : `bewaakt door: ${gefaald.slice(0, 2).join(" / ").slice(0, 160)}`;
    regels.push(
      `| ${naam} | ${wat} | ${groen ? "groen" : `rood (${gefaald.length})`} | ${conclusie} |`,
    );
  }
} finally {
  writeFileSync(MIGRATIE, origineel);
}
const tabel = regels.join("\n");
console.log(tabel);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## Mutaties op de migratie van het klantportaal\n\n${tabel}\n`,
  );
process.exit(kapot ? 1 : 0);
