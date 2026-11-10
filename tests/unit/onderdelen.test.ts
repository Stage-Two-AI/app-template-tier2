import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { GEEN_ONDERDEEL, ONDERDELEN } from "../../src/onderdelen";

/**
 * De lijst met onderdelen (src/onderdelen.ts) blijft bij met de router. De browsertest
 * e2e/onderdelen.spec.ts opent elk onderdeel uit die lijst; een hoofdpad dat er niet in
 * staat, opent hij dus nooit. Deze test maakt dat rood, zodat niemand eraan hoeft te denken.
 *
 * Welke hoofdpaden er zijn, zegt scripts/lib/onderdelen.mjs: een router (`<Route path="/...">`,
 * `path: "/..."`) of een eigen keuze op het pad (`pathname === "/plugin"`,
 * `pad.startsWith("/beheer")`). /stagetwo-tier2:updaten gebruikt dezelfde regel om
 * src/onderdelen.ts te vullen, dus test en plugin tellen nooit verschillend.
 *
 * Deze test is van de template en komt met elke versie mee.
 */
const WORTEL = resolve(__dirname, "../..");
const LIB = pathToFileURL(resolve(WORTEL, "scripts/lib/onderdelen.mjs")).href;
const { hoofdpad, hoofdpaden, padenInTekst } = (await import(LIB)) as {
  hoofdpad: (pad: string) => string | null;
  hoofdpaden: (map: string) => string[];
  padenInTekst: (tekst: string) => string[];
};

describe("src/onderdelen.ts", () => {
  const routes = new Set(hoofdpaden(WORTEL));
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

describe("scripts/lib/onderdelen.mjs: welke paden tellen", () => {
  it("een router: Route path, path={...} en path: in een lijst", () => {
    const tekst = '<Route path="/klanten/:id" /> <Route path={"/orders"} /> { path: "/rapport" }';
    expect(padenInTekst(tekst).map(hoofdpad)).toEqual(["/klanten", "/orders", "/rapport"]);
  });

  it("een eigen keuze op het pad, ook via een naam die het pad vasthoudt (zoals stagetwo-site)", () => {
    const tekst = [
      "const pad = window.location.pathname;",
      'if (pad === "/beheer/voorbeeld") {} else if (pad === "/") {}',
      'if (url.pathname.startsWith("/api/")) {}',
      'if ("/hallo" === pad) {}',
      'switch (pad) { case "/plugin": break; }',
    ].join("\n");
    expect(padenInTekst(tekst).map(hoofdpad).sort()).toEqual([
      "/",
      "/api",
      "/beheer",
      "/hallo",
      "/plugin",
    ]);
  });

  it("geen pad: een relatief pad, een vergelijking met iets anders dan het pad, een los woord", () => {
    const tekst =
      'const naam = "/x"; if (soort === "/y") {} <Route path="details" /> "/z".startsWith("/")';
    expect(padenInTekst(tekst)).toEqual([]);
  });
});
