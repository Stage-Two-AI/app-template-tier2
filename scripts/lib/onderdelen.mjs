import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * De zoekregel voor de hoofdpaden van een app, op één plek. Twee lezers:
 * - tests/unit/onderdelen.test.ts (van de template) vergelijkt ze met src/onderdelen.ts;
 * - /stagetwo-tierN:updaten draait dit bestand (`node scripts/lib/onderdelen.mjs` in de app)
 *   om src/onderdelen.ts eenmalig te vullen als het nog ontbreekt.
 * Zo tellen plugin en test nooit verschillend.
 *
 * Herkend in src/ (niet in tests):
 * - een router: `<Route path="/...">`, `path={"/..."}` en `path: "/..."`;
 * - een eigen keuze op het pad, zoals stagetwo-site die maakt: `pathname === "/plugin"`,
 *   `pathname.startsWith("/beheer")`, en hetzelfde met een naam die het pad vasthoudt
 *   (`const pad = window.location.pathname; if (pad === "/hallo")`) of `case "/x":` in een
 *   `switch (pad)`.
 * Alleen paden die met een `/` beginnen tellen; het hoofdpad is het eerste stuk:
 * `/klanten/:id` hoort bij `/klanten`.

 * Dit bestand is van de template en komt met elke versie mee.
 */

const ROUTER = /\bpath(?:=\{?|:\s*)["'`](\/[^"'`]*)["'`]/g;
const PAD = String.raw`["'\`](\/[^"'\`]*)["'\`]`;

function bestanden(map) {
  if (!existsSync(map)) return [];
  return readdirSync(map).flatMap((naam) => {
    const pad = join(map, naam);
    if (statSync(pad).isDirectory()) return bestanden(pad);
    return /\.tsx?$/.test(naam) && !/\.test\.tsx?$/.test(naam) ? [pad] : [];
  });
}

/** Het hoofdpad: `/klanten/:id` wordt `/klanten`; null voor `/:id` en `/*`. */
export function hoofdpad(pad) {
  const eerste = String(pad).split("/").filter(Boolean)[0];
  if (eerste === undefined) return "/";
  if (eerste.startsWith(":") || eerste === "*") return null;
  return `/${eerste}`;
}

/** Namen die het pad vasthouden: `pathname` zelf, en `x` in `const x = ....pathname`. */
function padNamen(tekst) {
  const namen = new Set(["pathname"]);
  for (const m of tekst.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*[\w$.?]*\bpathname\b/g,
  )) {
    if (m[1]) namen.add(m[1]);
  }
  for (const m of tekst.matchAll(/\{\s*pathname\s*:\s*([A-Za-z_$][\w$]*)\s*\}/g)) {
    if (m[1]) namen.add(m[1]);
  }
  return [...namen];
}

/** Alle paden (nog niet ingekort) die in één bestand een route of een keuze op het pad zijn. */
export function padenInTekst(tekst) {
  const paden = [...tekst.matchAll(ROUTER)].map((m) => m[1] ?? "");
  const naam = `(?:${padNamen(tekst).join("|")})`;
  const patronen = [
    new RegExp(`\\b${naam}\\s*[!=]==?\\s*${PAD}`, "g"),
    new RegExp(`${PAD}\\s*[!=]==?\\s*(?:[\\w$]+\\.)*${naam}\\b`, "g"),
    new RegExp(`\\b${naam}\\??\\.startsWith\\(\\s*${PAD}`, "g"),
  ];
  for (const patroon of patronen) for (const m of tekst.matchAll(patroon)) paden.push(m[1] ?? "");
  if (new RegExp(`\\bswitch\\s*\\(\\s*(?:[\\w$]+\\.)*${naam}\\s*\\)`).test(tekst)) {
    for (const m of tekst.matchAll(new RegExp(`\\bcase\\s+${PAD}\\s*:`, "g")))
      paden.push(m[1] ?? "");
  }
  return paden;
}

/** De hoofdpaden in src/ van de app in `map`, gesorteerd. */
export function hoofdpaden(map = process.cwd()) {
  const uit = new Set();
  for (const bestand of bestanden(join(map, "src"))) {
    for (const pad of padenInTekst(readFileSync(bestand, "utf8"))) {
      const hoofd = hoofdpad(pad);
      if (hoofd) uit.add(hoofd);
    }
  }
  return [...uit].sort();
}

// Los gedraaid (zo doet updaten het): de hoofdpaden van de app in deze map, als JSON.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(hoofdpaden())}\n`);
}
