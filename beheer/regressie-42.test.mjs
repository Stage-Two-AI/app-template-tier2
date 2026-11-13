/**
 * Een bestaande toegang.json zonder `klantportaal` geeft exact dezelfde inrichting als op
 * versie 42. Drie klanten draaien hierop; het klantportaal (uitgave 43) mag voor hen niets
 * veranderen.
 *
 * regressie-42.json is vastgelegd met de code van versie 42 zelf (stack-v42, zie
 * regressie-42.maak.mjs): per scenario elke aanroep naar Cloudflare, Supabase en GitHub, in
 * volgorde, met methode, adres, kopregels en body, plus het resultaat van het script. Deze
 * test draait dezelfde scenario's (regressie-scenarios.mjs) met de code van nu en legt de
 * twee naast elkaar. Ook lezen telt: één extra GET voor een gewone app is al een verschil.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { richtIn, ruimOp, tweedeDoorgang, werkToegangBij } from "./inrichten-cloudflare.mjs";
import { cloudflareClient } from "./lib/cloudflare.mjs";
import { supabaseBeheer } from "./lib/supabase.mjs";
import { nepWolk } from "./nep-wolk.mjs";
import { draaiScenarios } from "./regressie-scenarios.mjs";

const verwacht = JSON.parse(readFileSync(new URL("./regressie-42.json", import.meta.url), "utf8"));
const nu = await draaiScenarios({
  richtIn,
  werkToegangBij,
  tweedeDoorgang,
  ruimOp,
  cloudflareClient,
  supabaseBeheer,
  nepWolk,
});

test("regressie: dezelfde scenario's als bij het vastleggen op versie 42", () => {
  assert.deepEqual(Object.keys(nu), Object.keys(verwacht));
  assert.ok(Object.keys(verwacht).length >= 26);
});

test("regressie: de verwachting is niet leeg en bevat elke soort aanroep", () => {
  const alles = Object.values(verwacht).flatMap((s) => s.aanroepen);
  assert.ok(alles.length > 400, `${alles.length} aanroepen`);
  const heeft = (f) => assert.ok(alles.some(f));
  heeft((a) => a.soort === "fetch" && a.methode === "POST" && /access\/apps$/.test(a.url));
  heeft((a) => a.soort === "fetch" && a.methode === "PATCH" && /config\/auth$/.test(a.url));
  heeft((a) => a.soort === "fetch" && a.methode === "DELETE" && /access\/apps\//.test(a.url));
  heeft((a) => a.soort === "admin" && a.methode === "updateUserById");
  heeft((a) => a.soort === "admin" && a.methode === "createProvider");
  heeft((a) => a.soort === "gh" && a.args[0] === "secret" && a.args[1] === "set");
  // Geen scenario kent het klantportaal: nergens mail, nergens een SMTP-veld.
  const tekst = JSON.stringify(verwacht);
  assert.ok(!/smtp_|klantportaal|rate_limit|captcha|mailer_otp/.test(tekst));
  assert.match(tekst, /"external_email_enabled": ?false/);
  assert.match(tekst, /"mailer_autoconfirm": ?true/);
});

for (const [naam, scenario] of Object.entries(verwacht)) {
  test(`regressie zonder klantportaal, exact als versie 42: ${naam}`, () => {
    const nieuw = nu[naam];
    assert.ok(nieuw, "het scenario ontbreekt");
    // Eerst de korte vorm: wijst bij een verschil meteen de aanroep aan.
    const kort = (s) =>
      s.aanroepen.map((a) => `${a.soort} ${a.methode ?? ""} ${a.url ?? a.args?.join(" ")}`);
    assert.deepEqual(kort(nieuw), kort(scenario));
    assert.deepEqual(nieuw.aanroepen, scenario.aanroepen);
    assert.deepEqual(nieuw.fout ?? null, scenario.fout ?? null);
    assert.deepEqual(nieuw.resultaat ?? null, scenario.resultaat ?? null);
  });
}
