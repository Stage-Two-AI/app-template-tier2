// AANVAL, doel 7: tests die niets bewijzen. Haalt per keer één bescherming uit de migratie
// van het klantportaal, bouwt de lokale database opnieuw op en draait de bestaande test
// tests/rls/klantportaal.test.ts. Blijft die groen, dan bewaakt geen test die bescherming.
// Alleen in CI (heeft Docker nodig). Uitvoer: een tabel in de stapsamenvatting.
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const MIGRATIE = "supabase/migrations/20261114100000_klantportaal.sql";
const origineel = readFileSync(MIGRATIE, "utf8");

/** [naam, wat er wegvalt, zoek, vervang] */
const MUTATIES = [
  ["m0-geen", "niets (de test moet groen zijn)", null, null],
  ["m1-amr-weg", "de amr-controle: elke inlogmanier telt", "where stap ->> 'method' = 'oauth'", "where true"],
  ["m1b-amr-niet-otp", "de amr-controle verzwakt: alles behalve otp telt", "where stap ->> 'method' = 'oauth'", "where stap ->> 'method' <> 'otp'"],
  ["m2-12uur-weg", "de twaalf uur", "and s.created_at > now() - instelling.medewerkersessie_geldig", ""],
  ["m2b-12uur-vanaf-verversen", "de twaalf uur tellen vanaf het laatste verversen", "and s.created_at > now()", "and coalesce(s.refreshed_at at time zone 'utc', s.created_at) > now()"],
  ["m3-sessie-van-token-weg", "de sessie hoeft niet die van dit token te zijn (elke sessie van het account telt)", "where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid\n         and s.user_id = auth.uid()", "where s.user_id = auth.uid()"],
  ["m3b-sessie-eigenaar-weg", "de sessie hoeft niet van dit account te zijn", "and s.user_id = auth.uid()\n", "\n"],
  ["m3c-sessie-bestaat-weg", "de sessie hoeft niet meer te bestaan (uitloggen helpt niet)", "from auth.sessions s, instelling\n       where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid\n         and s.user_id = auth.uid()\n         and s.created_at > now() - instelling.medewerkersessie_geldig", "from instelling\n       where to_timestamp((auth.jwt() -> 'amr' -> 0 ->> 'timestamp')::bigint) > now() - instelling.medewerkersessie_geldig"],
  ["m4-cloudflare-identiteit-weg", "het account hoeft geen Cloudflare-identiteit te hebben", "and i.provider = 'custom:cloudflare'\n    )\n    and not exists", "and true\n    )\n    and not exists"],
  ["m5-tweede-dienst-mag", "een tweede inlogdienst aan het account mag", "and i.provider not in ('custom:cloudflare', 'email')", "and false"],
  ["m6-policy-select-open", "de select-policy: iedereen ziet alle klanten", "using ((select auth.uid()) = user_id or (select public.is_medewerker()));", "using (true);"],
  ["m7-policy-update-eigen", "de update-policy: een klant wijzigt zijn eigen regel", "using ((select public.is_medewerker()))\n  with check ((select public.is_medewerker()));", "using ((select auth.uid()) = user_id or (select public.is_medewerker()))\n  with check (true);"],
  ["m7b-policy-update-withcheck", "alleen de with check van de update-policy", "with check ((select public.is_medewerker()));", "with check (true);"],
  ["m8-grant-alle-kolommen", "de smalle grant: alle kolommen wijzigbaar", "grant update (goedgekeurd) on public.klanten to authenticated;", "grant update on public.klanten to authenticated;"],
  ["m8b-grant-insert-delete", "klanten mogen zelf een regel maken of weghalen (grant + policy op eigen regel)", "grant select on public.klanten to authenticated;", "grant select, insert, delete on public.klanten to authenticated;\ncreate policy x_ins on public.klanten for insert to authenticated with check ((select auth.uid()) = user_id);\ncreate policy x_del on public.klanten for delete to authenticated using ((select auth.uid()) = user_id);"],
  ["m9-goedkeuring-telt-niet", "is_goedgekeurde_klant kijkt niet naar goedgekeurd", "and k.goedgekeurd\n", "\n"],
  ["m10-anon-mag-functies", "de revoke voor bezoekers zonder inlog op drie van de vier functies", "revoke all on function public.sessie_via_cloudflare() from public, anon;\nrevoke all on function public.is_medewerker() from public, anon;\nrevoke all on function public.klant_aanmelden() from public, anon;\nrevoke all on function public.is_goedgekeurde_klant() from public, anon;", "revoke all on function public.is_medewerker() from public, anon;"],
  ["m11-adres-uit-token", "klant_aanmelden neemt het adres uit user_metadata van het token als dat er is", "select u.id, u.email\n", "select u.id, coalesce(auth.jwt() -> 'user_metadata' ->> 'e_mail', u.email)\n"],
  ["m12-rls-uit", "RLS op klanten staat uit", "alter table public.klanten enable row level security;", "-- rls uit"],
];

const alleen = process.argv.slice(2);
const regels = ["| mutatie | wat valt weg | bestaande test | conclusie |", "|---|---|---|---|"];
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
      regels.push(`| ${naam} | ${wat} | - | database bouwt niet: ${String(reset.stderr).trim().split("\n").pop()} |`);
      continue;
    }
    const test = spawnSync(
      "pnpm",
      ["exec", "vitest", "run", "--config", "vitest.rls.config.ts", "tests/rls/klantportaal.test.ts", "tests/rls/items.test.ts", "tests/rls/open-policies.test.ts"],
      { encoding: "utf8" },
    );
    const uit = `${test.stdout}\n${test.stderr}`;
    const gefaald = [...uit.matchAll(/^\s*(?:×|✗|FAIL)\s+(.*)$/gm)].map((t) => t[1].trim());
    const groen = test.status === 0;
    console.log(`=== ${naam}: ${groen ? "GROEN" : "ROOD"}\n${gefaald.slice(0, 12).join("\n")}`);
    const conclusie =
      zoek === null
        ? groen ? "uitgangspunt klopt" : "UITGANGSPUNT ROOD"
        : groen ? "**ONBEWAAKT**: de test blijft groen" : "bewaakt";
    regels.push(`| ${naam} | ${wat} | ${groen ? "groen" : `rood (${gefaald.filter((r) => r.includes(">")).length || "?"} falend)`} | ${conclusie} |`);
  }
} finally {
  writeFileSync(MIGRATIE, origineel);
}
const tabel = regels.join("\n");
console.log(tabel);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Mutaties op de migratie van het klantportaal\n\n${tabel}\n`);
process.exit(kapot ? 1 : 0);
