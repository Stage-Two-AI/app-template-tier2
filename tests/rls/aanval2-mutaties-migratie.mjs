// AANVAL ronde 2, doel 6: mutaties op de migratie van het klantportaal die niet in de lijst van
// de bouwer staan (.github/tijdelijk/mutaties-klantportaal.mjs). Zelfde werkwijze: per keer één
// bescherming weghalen, de lokale database opnieuw opbouwen en de RLS-tests van de template
// draaien (zonder de aanvalstests). Blijven die groen, dan bewaakt geen test die bescherming.
//
//   node tests/rls/aanval2-mutaties-migratie.mjs [naam ...]     (vraagt een lokale Supabase)
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const MIGRATIE = "supabase/migrations/20261114100000_klantportaal.sql";
const origineel = readFileSync(MIGRATIE, "utf8");

/** [naam, wat er wegvalt, zoek, vervang] */
const MUTATIES = [
  ["a0-geen", "niets (de tests moeten groen zijn)", null, null],
  [
    "a1-goedgekeurd-sessie-van-ander",
    "is_goedgekeurde_klant: de sessie hoeft niet van dit account te zijn",
    "     where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid\n       and s.user_id = auth.uid()\n  )\n$$;",
    "     where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid\n  )\n$$;",
  ],
  [
    "a2-aanmelden-sessie-van-ander",
    "klant_aanmelden: de sessie hoeft niet van dit account te zijn",
    "        where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid\n          and s.user_id = auth.uid()\n     )\n  on conflict",
    "        where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid\n     )\n  on conflict",
  ],
  [
    "a3-zoekpad-weg",
    "`set search_path = ''` op sessie_via_cloudflare (de eerste security definer-functie)",
    "stable\nsecurity definer\nset search_path = ''\nas $$\n  -- Zo lang",
    "stable\nsecurity definer\nas $$\n  -- Zo lang",
  ],
  [
    "a4-triggerfunctie-voor-iedereen",
    "de revoke op klant_adres_gewijzigd (de functie achter de trigger)",
    "revoke all on function public.klant_adres_gewijzigd() from public, anon, authenticated;\n",
    "",
  ],
  [
    "a5-sessies-alleen-van-aangemelde-klanten",
    "na een adreswijziging eindigen alleen de sessies van wie al op de lijst staat",
    "delete from auth.sessions where user_id = new.id;",
    "delete from auth.sessions where user_id = new.id and exists (select 1 from public.klanten k where k.user_id = new.id);",
  ],
  [
    "a6-revoke-op-tabel-weg",
    "de revoke op de tabel klanten: de standaardrechten van Supabase blijven staan (ook voor bezoekers)",
    "revoke all on public.klanten from public, anon, authenticated;\n",
    "",
  ],
  [
    "a7-trigger-niet-bij-leeg-adres",
    "de trigger vuurt niet als het adres leeg was of leeg wordt (`<>` in plaats van `is distinct from`)",
    "when (old.email is distinct from new.email)",
    "when (old.email <> new.email)",
  ],
  [
    "a8-derde-inlogmanier-mag",
    "een koppeling `phone` aan het account telt niet meer als tweede inlogdienst",
    "and i.provider not in ('custom:cloudflare', 'email')",
    "and i.provider not in ('custom:cloudflare', 'email', 'phone')",
  ],
  [
    "a9-twaalf-uur-wordt-dertien",
    "de constante: dertien uur in plaats van twaalf",
    "interval '12 hours'",
    "interval '13 hours'",
  ],
];

const alleen = process.argv.slice(2);
const regels = ["| mutatie | wat valt weg | RLS-tests | conclusie |", "|---|---|---|---|"];
try {
  for (const [naam, wat, zoek, vervang] of MUTATIES) {
    if (alleen.length > 0 && !alleen.includes(naam)) continue;
    let sql = origineel;
    if (zoek !== null) {
      if (!origineel.includes(zoek)) {
        regels.push(`| ${naam} | ${wat} | - | MUTATIE PAST NIET (zoektekst niet gevonden) |`);
        continue;
      }
      sql = origineel.replace(zoek, vervang);
    }
    if (process.env.DROOG) {
      regels.push(`| ${naam} | ${wat} | - | past |`);
      continue;
    }
    writeFileSync(MIGRATIE, sql);
    let reset = spawnSync("pnpm", ["exec", "supabase", "db", "reset"], { encoding: "utf8" });
    if (reset.status !== 0) {
      // Het opnieuw opbouwen hapert soms zonder dat het aan de migratie ligt: één herhaling.
      console.log(
        `=== ${naam}: reset mislukt\n${String(reset.stderr).trim().split("\n").slice(-12).join("\n")}`,
      );
      reset = spawnSync("pnpm", ["exec", "supabase", "db", "reset"], { encoding: "utf8" });
    }
    if (reset.status !== 0) {
      regels.push(
        `| ${naam} | ${wat} | - | database bouwt niet: ${String(reset.stderr).trim().split("\n").pop()} |`,
      );
      continue;
    }
    const test = spawnSync(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--config",
        "vitest.rls.config.ts",
        "--exclude",
        "tests/rls/aanval2-*",
      ],
      { encoding: "utf8" },
    );
    // biome-ignore lint/suspicious/noControlCharactersInRegex: kleurcodes beginnen met ESC
    const uit = `${test.stdout}\n${test.stderr}`.replace(/\u001b\[[0-9;]*m/g, "");
    const gefaald = [
      ...new Set(
        [...uit.matchAll(/^\s*(?:×|✗)\s+(.*?)(?:\s+\d+\s*ms)?$/gm)].map((t) => t[1].trim()),
      ),
    ];
    const groen = test.status === 0;
    console.log(`=== ${naam}: ${groen ? "GROEN" : "ROOD"}\n${gefaald.slice(0, 12).join("\n")}`);
    if (!groen && gefaald.length === 0) console.log(uit.slice(-3000));
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
    `## Aanval 2: mutaties op de migratie van het klantportaal\n\n${tabel}\n`,
  );
