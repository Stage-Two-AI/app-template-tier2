import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

/**
 * De beoordeling van de databasecontrole van een klantportaal (scripts/lib/klantportaal-database.mjs),
 * zonder database: met kleine, zelfgemaakte modellen zoals de catalogus ze teruggeeft. Dat de
 * vraag aan de catalogus klopt en elke bekende omweg afkeurt, bewijst
 * tests/rls/klantportaal-controle.test.ts op de echte database.
 *
 * En: klantportaal-basis.json (de verwachting voor de basisfuncties) klopt met de migratie van
 * het klantportaal.
 *
 * Deze test is van de template en komt met elke versie mee.
 */
vi.setConfig({ testTimeout: 60_000 });

const MODULE = pathToFileURL(
  resolve(__dirname, "../../scripts/lib/klantportaal-database.mjs"),
).href;
const MIGRATIES = resolve(__dirname, "../../supabase/migrations");

function roep<T>(code: string, invoer: unknown): T {
  const script = `import(${JSON.stringify(MODULE)}).then((m) => { const a = JSON.parse(process.argv.at(-1)); process.stdout.write(JSON.stringify(${code})); })`;
  return JSON.parse(
    execFileSync("node", ["--input-type=module", "-e", script, "--", JSON.stringify(invoer)], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  ) as T;
}

type Basis = {
  functies: Record<string, Record<string, unknown>>;
  triggers: Array<Record<string, unknown>>;
  klanten: { kolommen: string[]; rechten: string[] };
};
const BASIS: Basis = JSON.parse(
  readFileSync(resolve(__dirname, "../../scripts/lib/klantportaal-basis.json"), "utf8"),
);

/** De basis zoals de database hem teruggeeft als alles klopt. */
const goedeBasis = () => ({
  functies: Object.entries(BASIS.functies).map(([naam, f]) => ({ naam, args: "", ...f })),
  triggers: BASIS.triggers,
  klanten: BASIS.klanten,
});

const tabel = (naam: string, extra: Record<string, unknown> = {}) => ({
  naam,
  soort: "r",
  rls: true,
  policies: 1,
  invoker: false,
  anon: true,
  ingelogd: true,
  supabase: false,
  eigenaarBezoeker: false,
  ...extra,
});
const policy = (extra: Record<string, unknown> = {}) => ({
  tabel: "public.orders",
  naam: "p",
  permissief: true,
  cmd: "select",
  anon: false,
  ingelogd: true,
  using: "public.is_medewerker()",
  check: null,
  ...extra,
});
const functie = (extra: Record<string, unknown> = {}) => ({
  naam: "public.f",
  args: "",
  definer: false,
  anon: false,
  ingelogd: true,
  supabase: false,
  zoekpad: null,
  taal: "sql",
  bron: "select 1",
  ...extra,
});

type Model = Record<string, unknown>;
const beoordeel = (model: Model, config: Record<string, unknown> = {}) =>
  roep<string[]>("m.beoordeelDatabase(a.model, a.config)", {
    model: { basis: goedeBasis(), ...model },
    config,
  });

describe("de databasecontrole: de beoordeling", () => {
  it("een database met alleen de basis, goed: niets mis", () => {
    expect(beoordeel({})).toEqual([]);
  });

  it("tabellen: RLS aan en een policy; van Supabase alleen RLS aan als bezoekers erbij kunnen", () => {
    expect(beoordeel({ relaties: [tabel("public.orders")] })).toEqual([]);
    expect(
      beoordeel({
        relaties: [tabel("public.orders", { rls: false, anon: false, ingelogd: false })],
      }),
    ).toEqual([
      "public.orders: row level security staat uit. Zo staat de tabel open voor iedereen met rechten erop",
    ]);
    expect(beoordeel({ relaties: [tabel("public.orders", { soort: "p", policies: 0 })] })).toEqual([
      "public.orders: row level security staat aan, maar er is geen enkele policy",
    ]);
    expect(
      beoordeel({ relaties: [tabel("storage.objects", { supabase: true, policies: 0 })] }),
    ).toEqual([]);
    expect(
      beoordeel({
        relaties: [
          tabel("storage.x", { supabase: true, rls: false, anon: false, ingelogd: false }),
        ],
      }),
    ).toEqual([]);
    // Een tabel van Supabase zonder RLS is van Supabase (realtime.subscription); alleen de
    // tabellen waar de app policies op zet, moeten RLS houden.
    expect(
      beoordeel({ relaties: [tabel("realtime.subscription", { supabase: true, rls: false })] }),
    ).toEqual([]);
    expect(
      beoordeel({
        relaties: [tabel("storage.objects", { supabase: true, rls: false, anon: false })],
      }),
    ).toEqual(["storage.objects: row level security staat uit, en bezoekers hebben er rechten op"]);
    expect(
      beoordeel({ relaties: [tabel("public.orders", { eigenaarBezoeker: true })] }),
    ).toHaveLength(1);
  });

  it("views, materialized views en foreign tables", () => {
    const view = (extra: Record<string, unknown>) => tabel("public.v", { soort: "v", ...extra });
    expect(beoordeel({ relaties: [view({ invoker: true })] })).toEqual([]);
    expect(beoordeel({ relaties: [view({ anon: false, ingelogd: false })] })).toEqual([]);
    expect(beoordeel({ relaties: [view({ anon: false })] })).toEqual([
      "public.v: een view zonder security_invoker gaat langs de policies heen (hij leest met de rechten van zijn eigenaar)",
    ]);
    expect(beoordeel({ relaties: [view({ anon: false })] }, { vrijeFuncties: { v: "x" } })).toEqual(
      [],
    );
    expect(beoordeel({ relaties: [view({})] }, { vrijeFuncties: { v: "x" } })).toEqual([
      "public.v: een view met de rechten van zijn eigenaar, te lezen zonder account (anon)",
    ]);
    expect(
      beoordeel({ relaties: [view({})] }, { vrijeFuncties: { v: "x" }, openbaar: { v: "y" } }),
    ).toEqual([]);
    for (const soort of ["m", "f"]) {
      expect(
        beoordeel({ relaties: [tabel("public.x", { soort, anon: false })] }),
        soort,
      ).toHaveLength(1);
      expect(
        beoordeel({ relaties: [tabel("public.x", { soort, anon: false, ingelogd: false })] }),
      ).toEqual([]);
    }
  });

  it("rollen waar bezoekers lid van zijn en die langs RLS mogen", () => {
    expect(beoordeel({ rollen: ["service_role"] })).toHaveLength(1);
  });

  it("policies voor anon alleen met klantportaal_openbaar; voor ingelogden een poort", () => {
    const anon = policy({ anon: true, ingelogd: false, using: "true" });
    expect(beoordeel({ policies: [anon] })).toHaveLength(1);
    expect(beoordeel({ policies: [anon] }, { openbaar: { orders: "catalogus" } })).toEqual([]);
    expect(beoordeel({ policies: [{ ...anon, permissief: false }] })).toEqual([]);
    expect(beoordeel({ policies: [policy({ using: "auth.uid() = owner_id" })] })).toHaveLength(1);
    expect(beoordeel({ policies: [policy({ check: "true", cmd: "update" })] })).toHaveLength(1);
    // Gedekt door een restrictive policy, per opdracht.
    const poort = policy({ permissief: false, cmd: "all", using: "public.is_medewerker()" });
    const eigen = policy({ cmd: "all", using: "auth.uid() = owner_id" });
    expect(beoordeel({ policies: [poort, eigen] })).toEqual([]);
    expect(beoordeel({ policies: [{ ...poort, cmd: "select" }, eigen] })).toHaveLength(1);
    expect(beoordeel({ policies: [{ ...poort, check: "true" }, eigen] })).toHaveLength(1);
    expect(beoordeel({ policies: [{ ...poort, ingelogd: false }, eigen] })).toHaveLength(1);
    expect(beoordeel({ policies: [{ ...poort, tabel: "public.ander" }, eigen] })).toHaveLength(1);
    // Een eigen poort telt alleen als hij is opgegeven (en klopt).
    const inkoper = policy({ using: "public.is_inkoper()" });
    const eigenPoort = functie({
      naam: "public.is_inkoper",
      bron: "select public.is_medewerker() and x",
    });
    expect(beoordeel({ policies: [inkoper], functies: [eigenPoort] })).toHaveLength(1);
    expect(
      beoordeel(
        { policies: [inkoper], functies: [eigenPoort] },
        { poorten: { is_inkoper: "inkoop" } },
      ),
    ).toEqual([]);
  });

  it("functies: definer alleen met een reden, anon alleen in klantportaal_openbaar, een vast zoekpad", () => {
    expect(beoordeel({ functies: [functie()] })).toEqual([]);
    expect(beoordeel({ functies: [functie({ anon: true, ingelogd: false })] })).toEqual([
      "public.f(): bezoekers zonder account (anon) mogen hem uitvoeren, en hij staat niet in klantportaal_openbaar",
    ]);
    expect(beoordeel({ functies: [functie({ anon: true })] }, { openbaar: { f: "x" } })).toEqual(
      [],
    );
    const definer = functie({ definer: true, zoekpad: 'search_path=""' });
    expect(beoordeel({ functies: [definer] })).toEqual([
      "public.f(): security definer (hij leest met de rechten van zijn eigenaar), en iedereen met een e-mailadres mag hem uitvoeren",
    ]);
    expect(beoordeel({ functies: [definer] }, { vrijeFuncties: { f: "x" } })).toEqual([]);
    expect(
      beoordeel({ functies: [{ ...definer, zoekpad: null }] }, { vrijeFuncties: { f: "x" } }),
    ).toEqual(["public.f(): security definer zonder vast zoekpad; zet `set search_path = ''`"]);
    expect(beoordeel({ functies: [{ ...definer, ingelogd: false }] })).toEqual([]);
    expect(beoordeel({ functies: [{ ...definer, supabase: true }] })).toEqual([]);
    expect(
      beoordeel({ functies: [{ ...definer, naam: "api.f" }] }, { vrijeFuncties: { f: "x" } }),
    ).toHaveLength(1);
    expect(
      beoordeel({ functies: [{ ...definer, naam: "api.f" }] }, { vrijeFuncties: { "api.f": "x" } }),
    ).toEqual([]);
  });

  it("een eigen poort: bestaat, zonder argumenten, en is na te lopen", () => {
    const poorten = { is_inkoper: "inkoop" };
    expect(beoordeel({}, { poorten })).toEqual([
      "klantportaal_poorten.is_inkoper: er is geen functie public.is_inkoper() zonder argumenten",
    ]);
    const poort = (bron: string, taal = "sql") =>
      functie({ naam: "public.is_inkoper", bron, taal });
    expect(
      beoordeel({ functies: [poort("select public.is_medewerker() and x")] }, { poorten }),
    ).toEqual([]);
    for (const [bron, taal] of [
      ["select public.is_medewerker() or x", "sql"],
      ["begin return public.is_medewerker(); end", "plpgsql"],
      ["select x from t where public.is_medewerker()", "sql"],
    ] as const) {
      expect(beoordeel({ functies: [poort(bron, taal)] }, { poorten }), bron).toHaveLength(1);
    }
  });

  it("openbare buckets alleen met een reden", () => {
    expect(beoordeel({ buckets: ["logo"] })).toHaveLength(1);
    expect(beoordeel({ buckets: ["logo"] }, { openbaar: { "bucket:logo": "het logo" } })).toEqual(
      [],
    );
  });

  it("open_tabellen moet leeg zijn", () => {
    expect(beoordeel({}, { openTabellen: { x: "y" } })).toHaveLength(1);
  });

  it("de basis: elke afwijking is rood met de naam van wat er gewijzigd is", () => {
    const basis = goedeBasis();
    const met = (wijzig: (b: ReturnType<typeof goedeBasis>) => void) => {
      const kopie = structuredClone(basis);
      wijzig(kopie);
      return beoordeel({ basis: kopie });
    };
    for (const veld of [
      "hash",
      "definer",
      "zoekpad",
      "eigenaar",
      "taal",
      "terug",
      "volatiel",
      "anon",
      "ingelogd",
    ]) {
      const uit = met((b) => {
        const f = b.functies[0];
        if (f) (f as Record<string, unknown>)[veld] = "anders";
      });
      expect(uit, veld).toHaveLength(1);
      expect(uit[0]).toMatch(/^de basisfunctie public\.\w+\(\) is gewijzigd/);
    }
    expect(met((b) => b.functies.shift())[0]).toMatch(/ontbreekt/);
    expect(met((b) => b.triggers.pop())[0]).toMatch(/de trigger .* ontbreekt/);
    expect(
      met((b) => {
        const t = b.triggers[0];
        if (t) t.aan = "D";
      })[0],
    ).toMatch(/is gewijzigd of staat uit/);
    expect(
      met((b) => b.triggers.push({ naam: "x", tabel: "auth.users", definitie: "", aan: "O" }))[0],
    ).toMatch(/een eigen trigger/);
    expect(met((b) => b.klanten.rechten.push("anon: SELECT"))[0]).toMatch(/de rechten/);
    expect(met((b) => b.klanten.kolommen.pop())[0]).toMatch(/de kolommen/);
    expect(beoordeel({ basis: { ...basis, klanten: null } })[0]).toMatch(/klanten ontbreekt/);
  });
});

/**
 * De verwachting in klantportaal-basis.json komt uit de migratie van de template. In een app
 * zonder klantportaal is er niets te vergelijken.
 */
const metMigratie =
  existsSync(MIGRATIES) &&
  readdirSync(MIGRATIES).some((naam) => naam.endsWith("_klantportaal.sql"));

describe.runIf(metMigratie)("klantportaal-basis.json klopt met de migratie", () => {
  it("per basisfunctie de hash van de tekst, security definer, het zoekpad en de taal", () => {
    const sql = readdirSync(MIGRATIES)
      .filter((naam) => naam.endsWith(".sql"))
      .sort()
      .map((naam) => readFileSync(join(MIGRATIES, naam), "utf8"))
      .join("\n");
    // De module geeft per functie de tekst terug (als "hash" de tekst zelf); de hash rekenen we hier.
    const uitMigratie = roep<Record<string, Record<string, unknown>>>(
      "m.basisUitMigraties(a.sql, (tekst) => tekst)",
      { sql },
    );
    const namen = Object.keys(BASIS.functies).sort();
    expect(Object.keys(uitMigratie).sort()).toEqual(namen);
    for (const naam of namen) {
      const eis = BASIS.functies[naam] ?? {};
      const hash = createHash("sha256")
        .update(String(uitMigratie[naam]?.hash ?? ""), "utf8")
        .digest("hex");
      expect(hash, `de basisfunctie ${naam}: werk klantportaal-basis.json bij`).toBe(eis.hash);
      const kop = uitMigratie[naam] ?? {};
      expect(kop.definer).toBe(eis.definer);
      expect(kop.zoekpad).toEqual(eis.zoekpad);
      expect(kop.taal).toBe(eis.taal);
    }
  });
});
