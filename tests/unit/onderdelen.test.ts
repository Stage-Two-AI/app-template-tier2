import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GEEN_ONDERDEEL, ONDERDELEN } from "@/onderdelen";

/**
 * De lijst met onderdelen (src/onderdelen.ts) blijft bij met de router. De browsertest
 * e2e/onderdelen.spec.ts opent elk onderdeel uit die lijst; een hoofdpad dat er niet in
 * staat, opent hij dus nooit. Deze test maakt dat rood, zodat niemand eraan hoeft te denken.
 *
 * Gelezen worden de routes in src/ (`<Route path="/...">`, `path={"/..."}` en `path: "/..."`). Alleen paden die
 * met een `/` beginnen tellen: een relatief pad hoort bij een route erboven. Het hoofdpad is
 * het eerste stuk: `/klanten/:id` hoort bij `/klanten`.
 *
 * Deze test is van de template en komt met elke versie mee.
 */
const SRC = resolve(__dirname, "../../src");

function bestanden(map: string): string[] {
  return readdirSync(map).flatMap((naam) => {
    const pad = join(map, naam);
    if (statSync(pad).isDirectory()) return bestanden(pad);
    return /\.tsx?$/.test(naam) && !/\.test\.tsx?$/.test(naam) ? [pad] : [];
  });
}

function hoofdpad(pad: string): string | null {
  const eerste = pad.split("/").filter(Boolean)[0];
  if (eerste === undefined) return "/";
  if (eerste.startsWith(":") || eerste === "*") return null;
  return `/${eerste}`;
}

function routesInSrc(): Set<string> {
  const paden = new Set<string>();
  const patroon = /\bpath(?:=\{?|:\s*)["'`](\/[^"'`]*)["'`]/g;
  for (const bestand of bestanden(SRC)) {
    for (const m of readFileSync(bestand, "utf8").matchAll(patroon)) {
      const pad = hoofdpad(m[1] ?? "");
      if (pad) paden.add(pad);
    }
  }
  return paden;
}

describe("src/onderdelen.ts", () => {
  const routes = routesInSrc();
  const inLijst = new Set(ONDERDELEN.map((o) => hoofdpad(o.pad)));
  const bewustNiet = new Set(GEEN_ONDERDEEL.map(hoofdpad));

  it("elk hoofdpad in de router staat in de lijst (of bewust in GEEN_ONDERDEEL)", () => {
    const zonder = [...routes].filter((p) => !inLijst.has(p) && !bewustNiet.has(p)).sort();
    expect(
      zonder,
      "hoofdpaden zonder regel in src/onderdelen.ts: zet ze in ONDERDELEN (of in GEEN_ONDERDEEL als het geen onderdeel is)",
    ).toEqual([]);
  });

  it("elk onderdeel in de lijst heeft een route", () => {
    const weg = ONDERDELEN.filter((o) => !routes.has(hoofdpad(o.pad) ?? "")).map((o) => o.pad);
    expect(weg, "onderdelen zonder route in src/").toEqual([]);
  });

  it("elk onderdeel heeft een pad dat met / begint en een naam", () => {
    for (const o of ONDERDELEN) {
      expect(o.pad, o.naam).toMatch(/^\//);
      expect(o.naam.trim(), o.pad).not.toBe("");
    }
  });
});
