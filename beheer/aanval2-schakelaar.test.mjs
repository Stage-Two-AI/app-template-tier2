/**
 * AANVAL ronde 2, doel 2: de schakelaar `"klantportaal": true` in stack.config.json van de app
 * en de inrichting lopen niet gelijk, en niets dwingt dat af.
 *
 * De test SLAAGT als de aanval lukt: App inrichten haalt met het vinkje de deur weg van een app
 * waarvan stack.config.json de schakelaar NIET heeft en waarvan de migratie van het klantportaal
 * ontbreekt, zonder dat de inrichting die twee bestanden ook maar opvraagt.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { app, NAMEN, naarPortaal } from "./klantportaal-opzet.mjs";
import { nepWolk } from "./nep-wolk.mjs";

test("aanval2 2.5 GELUKT ALS: de deur gaat weg terwijl de app de schakelaar niet heeft; de inrichting leest stack.config.json en de migraties niet", async () => {
  const w = nepWolk({
    workerBestaat: true,
    ghBestanden: {
      "src/lib/env.ts": "leesInlogdiensten(waarden.VITE_INLOGDIENST)",
      // De app zoals de template hem levert: database aan, schakelaar uit, `items` zonder poort.
      "stack.config.json": JSON.stringify({ database: true, open_tabellen: {} }),
    },
  });
  const gelezen = [];
  const gh = async (args, opties) => {
    const pad = /^repos\/[^/]+\/[^/]+\/contents\/(.+)$/.exec(args[1] ?? "")?.[1];
    if (args[0] === "api" && pad) gelezen.push(pad);
    return w.gh(args, opties);
  };
  const r = await naarPortaal(w, undefined, undefined, { gh });

  assert.equal(app(w, NAMEN.deur), undefined, "de deur is weg: het domein staat open");
  assert.match(JSON.stringify(r), /open|live/);
  assert.ok(gelezen.includes("src/lib/env.ts"), "de inrichting las wel env.ts van de app");
  assert.ok(
    !gelezen.some((pad) => pad.includes("stack.config.json")),
    "de inrichting heeft stack.config.json van de app nooit opgevraagd",
  );
  assert.ok(
    !gelezen.some((pad) => pad.includes("supabase/migrations")),
    "de inrichting heeft niet gekeken of de migratie van het klantportaal er is",
  );
  assert.doesNotMatch(
    JSON.stringify(r),
    /stack\.config\.json[^"]*klantportaal|guard:rls/,
    "de uitvoer noemt de schakelaar of de guard nergens",
  );
});
