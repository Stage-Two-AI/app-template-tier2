import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * beheer/ moet op zichzelf kunnen draaien: gekopieerd naar een beheer-repo, samen met
 * dat ene bestand `scripts/lib/cloudflare-config.mjs` op hetzelfde relatieve pad. Deze
 * test draait zowel in de template als in zo'n kopie.
 */
const BEHEER = dirname(fileURLToPath(import.meta.url));
const TOEGESTAAN_BUITEN_BEHEER = resolve(BEHEER, "../scripts/lib/cloudflare-config.mjs");
const pakket = JSON.parse(readFileSync(join(BEHEER, "package.json"), "utf8"));

function bronbestanden(map) {
  return readdirSync(map, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules") return [];
    const pad = join(map, e.name);
    if (e.isDirectory()) return bronbestanden(pad);
    return e.name.endsWith(".mjs") ? [pad] : [];
  });
}

function imports(tekst) {
  return [...tekst.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+["']([^"']+)["']/gm)].map(
    (m) => m[1],
  );
}

test("pakket: eigen package.json met type module, node --test en supabase-js", () => {
  assert.equal(pakket.type, "module");
  assert.equal(pakket.private, true);
  assert.match(pakket.scripts?.test ?? "", /^node --test\b/);
  assert.ok(pakket.dependencies?.["@supabase/supabase-js"], "supabase-js staat erin");
});

/**
 * Dezelfde hoofdversie, niet exact dezelfde: Dependabot werkt alleen de package.json in de
 * hoofdmap bij (dependabot.yml gaat mee naar elke app, en daar bestaat beheer/ niet), dus een
 * exacte vergelijking maakte elke kleine update rood (melding 28-10-2026). beheer/ verhuist op
 * termijn helemaal naar beheer-template.
 */
test("pakket: supabase-js in dezelfde hoofdversie als de template (alleen in de template)", (t) => {
  const root = resolve(BEHEER, "../package.json");
  if (!existsSync(root)) return t.skip("geen template eromheen (kopie in een beheer-repo)");
  const template = JSON.parse(readFileSync(root, "utf8"));
  if (!template.dependencies?.["@supabase/supabase-js"]) return t.skip("geen template");
  const hoofd = (v) => v.replace(/^[^\d]*/, "").split(".")[0];
  assert.equal(
    hoofd(pakket.dependencies["@supabase/supabase-js"]),
    hoofd(template.dependencies["@supabase/supabase-js"]),
  );
});

test("pakket: imports blijven in beheer/, op de config-controle na, en pakketten staan in package.json", () => {
  const afhankelijk = new Set(Object.keys(pakket.dependencies ?? {}));
  const fouten = [];
  for (const bestand of bronbestanden(BEHEER)) {
    for (const bron of imports(readFileSync(bestand, "utf8"))) {
      const waar = relative(BEHEER, bestand);
      if (bron.startsWith("node:")) continue;
      if (bron.startsWith(".")) {
        const doel = resolve(dirname(bestand), bron);
        const binnen = !relative(BEHEER, doel).startsWith("..");
        if (!binnen && doel !== TOEGESTAAN_BUITEN_BEHEER) fouten.push(`${waar}: ${bron}`);
        continue;
      }
      const naam = bron.startsWith("@")
        ? bron.split("/").slice(0, 2).join("/")
        : bron.split("/")[0];
      if (!afhankelijk.has(naam)) fouten.push(`${waar}: pakket ${naam} staat niet in package.json`);
    }
  }
  assert.deepEqual(fouten, []);
});

// ---------------------------------------------------------------- de proef-workflows

const workflows = resolve(BEHEER, "..", ".github", "workflows");
const heeftWorkflows = existsSync(join(workflows, "proef-controle.yml"));

test("proef-workflows: de knop Controle van buitenaf heeft een eigen concurrency-groep (hij vervangt nooit een wachtende Toegang bijwerken), krijgt alleen leessleutels en leidt stdout nergens heen", {
  skip: heeftWorkflows ? false : "een losse kopie van beheer/ heeft de proef-workflows niet",
}, () => {
  const lees = (naam) => readFileSync(join(workflows, naam), "utf8");
  const groep = (yml) =>
    lees(yml).match(/concurrency:\n(?:\s*#.*\n)*\s*group: (\S+)\n\s*cancel-in-progress: (\S+)/);
  const controle = groep("proef-controle.yml");
  assert.equal(groep("proef-toegang.yml")[1], groep("proef-inrichten.yml")[1]);
  assert.notEqual(controle[1], groep("proef-toegang.yml")[1]);
  assert.equal(controle[2], "false");
  const knop = lees("proef-controle.yml");
  assert.doesNotMatch(knop, /\btee\b|GITHUB_STEP_SUMMARY"/);
  assert.deepEqual([...knop.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]).sort(), [
    "CLOUDFLARE_PROEF_TOKEN",
    "SUPABASE_ACCESS_TOKEN",
    "SUPABASE_ORG_SLUG",
  ]);
  for (const yml of ["proef-inrichten.yml", "proef-controle.yml", "proef-toegang.yml"]) {
    const tekst = lees(yml);
    // Invoer gaat via de omgeving; geheimen staan op precies één stap.
    assert.doesNotMatch(tekst.split("run: |")[1] ?? "", /\$\{\{/, yml);
    assert.equal((tekst.match(/^\s+env:/gm) ?? []).length, 1, yml);
  }
});

// ---------------------------------------------------------------- geen klantnamen

/**
 * Deze map gaat naar elke klant (via beheer-template). Er staat dus geen naam of domein van een
 * echte klant in: niet in de README, een voorbeeld, een foutmelding, commentaar of testgegevens.
 * De namen staan hier in stukken, zodat deze test zichzelf niet vindt.
 */
const KLANTNAMEN = [
  ["win", "co"],
  ["plan", "tas"],
  ["rich", "plant"],
  ["together", "2", "grow"],
  ["together", "to", "grow"],
  ["t", "2", "g"],
].map((delen) => delen.join(""));
/**
 * Twee bestanden zijn bevroren: de vastgelegde aanroepen van versie 42 en de scenario's
 * waarmee ze zijn gemaakt. Daarin staat nog een voorbeeldnaam van toen; ze veranderen pas als
 * de vergelijking met versie 42 vervalt.
 */
const BEVROREN = ["regressie-42.json", "regressie-scenarios.mjs"];

function alleBestanden(map) {
  return readdirSync(map, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules") return [];
    const pad = join(map, e.name);
    return e.isDirectory() ? alleBestanden(pad) : [pad];
  });
}

test("geen klantnamen of klantdomeinen in beheer/: de README, voorbeelden, foutmeldingen, commentaar en testgegevens gebruiken klant.nl, Voorbeeld en shop", () => {
  const patroon = new RegExp(KLANTNAMEN.join("|"), "i");
  const gevonden = [];
  for (const pad of alleBestanden(BEHEER)) {
    const naam = relative(BEHEER, pad);
    if (BEVROREN.includes(naam)) continue;
    readFileSync(pad, "utf8")
      .split("\n")
      .forEach((regel, i) => {
        const m = regel.match(patroon);
        if (m) gevonden.push(`${naam}:${i + 1}: ${m[0]}`);
      });
    assert.doesNotMatch(naam, patroon, `de bestandsnaam ${naam}`);
  }
  assert.deepEqual(gevonden, []);
  // De proef-workflows horen bij deze map; ook daar geen klantnaam.
  if (heeftWorkflows) {
    for (const yml of readdirSync(workflows).filter((n) => n.startsWith("proef-"))) {
      assert.doesNotMatch(readFileSync(join(workflows, yml), "utf8"), patroon, yml);
    }
  }
});

// ---------------------------------------------------------------- de documentatie klopt met de code

test("documentatie: elke verwijzing uit de code naar een kop in README.md of KLANTPORTAAL.md bestaat, de stappen noemen de meldingen die de code geeft, en de owner leest dat droogloop uit moet", () => {
  const readme = readFileSync(join(BEHEER, "README.md"), "utf8");
  const achtergrond = readFileSync(join(BEHEER, "KLANTPORTAAL.md"), "utf8");
  const koppen = (tekst) =>
    tekst
      .split("\n")
      .filter((r) => /^#{1,4} /.test(r))
      .map((r) => r.replace(/^#+ /, ""));
  const code = [
    "inrichten-cloudflare.mjs",
    "controle-doorsteek.mjs",
    "lib/toegang.mjs",
    "lib/supabase.mjs",
  ]
    .map((b) => readFileSync(join(BEHEER, b), "utf8"))
    .join("\n");
  const verwijzingen = [
    ...code.matchAll(/\\?"([^"\\]+)\\?" in (?:beheer\/)?(README|KLANTPORTAAL)\.md/g),
  ];
  assert.ok(verwijzingen.length >= 5);
  for (const [, kop, bestand] of verwijzingen) {
    const lijst = koppen(bestand === "README" ? readme : achtergrond);
    assert.ok(lijst.includes(kop), `de kop "${kop}" staat niet in ${bestand}.md`);
  }
  // De meldingen waar de stappen op wijzen, staan letterlijk in de code.
  const hoofdstuk = readme.slice(readme.indexOf("## Klantportaal"), readme.indexOf("## Alleen IT"));
  for (const melding of [
    "gestopt zonder wijzigingen",
    "de deur gaat niet weg, want er staat nog iets anders te wijzigen",
    "wacht op App inrichten",
    "de app begrijpt de inlog van een",
    "Turnstile kent dit geheim niet",
    "Alles staat klaar",
  ]) {
    assert.ok(hoofdstuk.replace(/\s+/g, " ").includes(melding), `README: ${melding}`);
    assert.ok(code.includes(melding.replace("de app begrijpt", "begrijpt")), `code: ${melding}`);
  }
  // Stap 3 en stap 5 zeggen uitdrukkelijk dat droogloop uit moet (het vakje staat aan).
  for (const stap of ["Stap 3", "Stap 5"]) {
    const a = hoofdstuk.indexOf(`**${stap}.`);
    const tekst = hoofdstuk.slice(a, hoofdstuk.indexOf("**Stap", a + 10));
    assert.match(tekst.replace(/\s+/g, " "), /\*\*zet "droogloop" uit\*\*/, stap);
  }
  if (heeftWorkflows) {
    const inrichten = readFileSync(join(workflows, "proef-inrichten.yml"), "utf8");
    assert.match(inrichten, /droogloop:\n(?:.*\n){2}\s+default: true/);
  }
  // Het hoofdstuk voor de owner is kort; de achtergrond staat één keer, in KLANTPORTAAL.md.
  const weten = hoofdstuk.slice(hoofdstuk.indexOf("### Wat je moet weten"));
  assert.ok(weten.split("\n").filter((r) => r.startsWith("- ")).length <= 10);
  assert.equal(new Set(koppen(achtergrond)).size, koppen(achtergrond).length);
  for (const tekst of [readme, achtergrond]) {
    assert.doesNotMatch(tekst, /"eigen_hooks": true|regel JSON|—/);
  }
  assert.doesNotMatch(hoofdstuk, /INRICHTING|logboek als/);
  assert.match(achtergrond, /## Open punten vóór de eerste klant\n[\s\S]*IPv6/);
  assert.doesNotMatch(hoofdstuk, /IPv6/);
});
