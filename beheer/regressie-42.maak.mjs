#!/usr/bin/env node
/**
 * Schrijft regressie-42.json: wat het inrichtingsscript van versie 42 in elk scenario uit
 * regressie-scenarios.mjs naar Cloudflare, Supabase en GitHub stuurt. De test
 * regressie-42.test.mjs legt de code van nu daarnaast.
 *
 * Dit draai je alleen om de verwachting opnieuw vast te leggen, tegen een uitgecheckte
 * versie 42 (tag stack-v42, commit 8687e69), nooit tegen de code van nu:
 *
 *   git worktree add /tmp/v42 stack-v42
 *   (cd /tmp/v42/beheer && pnpm install --frozen-lockfile)
 *   node beheer/regressie-42.maak.mjs /tmp/v42/beheer
 *   pnpm lint:fix        (zet het JSON-bestand in de opmaak van de repo)
 *
 * De scenario's komen uit deze map; de code en de nagebootste API (nep-wolk.mjs) uit de map
 * die je meegeeft. Zo bewijst de test ook dat een wijziging aan de nep-wolk een gewone app
 * niet raakt.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { draaiScenarios } from "./regressie-scenarios.mjs";

const map = process.argv[2];
if (!map) {
  console.error("Geef de map beheer/ van een uitgecheckte versie 42 mee.");
  process.exit(2);
}
const laad = (bestand) => import(pathToFileURL(resolve(map, bestand)).href);
const script = await laad("inrichten-cloudflare.mjs");
const m = {
  richtIn: script.richtIn,
  werkToegangBij: script.werkToegangBij,
  tweedeDoorgang: script.tweedeDoorgang,
  ruimOp: script.ruimOp,
  cloudflareClient: (await laad("lib/cloudflare.mjs")).cloudflareClient,
  supabaseBeheer: (await laad("lib/supabase.mjs")).supabaseBeheer,
  nepWolk: (await laad("nep-wolk.mjs")).nepWolk,
};
const uit = await draaiScenarios(m);
const doel = new URL("./regressie-42.json", import.meta.url);
writeFileSync(doel, `${JSON.stringify(uit, null, 2)}\n`);
const aantal = Object.values(uit).reduce((n, s) => n + s.aanroepen.length, 0);
console.log(
  `${Object.keys(uit).length} scenario's, ${aantal} aanroepen vastgelegd in regressie-42.json`,
);
