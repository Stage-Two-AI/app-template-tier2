import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * scripts/klantportaal-overnemen.mjs (stap 3 van docs/routes/klantportaal.md), op een kleine
 * nagebootste template met twee versies en twee apps: een met de indeling van de template
 * (weg A) en een met een eigen indeling (weg B). Zo is bewezen dat het samenvoegen de
 * dichtstbijzijnde versie als basis neemt, dat een eigen indeling niet half wordt samengevoegd,
 * en dat een verdwenen route opvalt.
 *
 * Deze test is van de template en komt met elke versie mee.
 */
const WORTEL = resolve(__dirname, "../..");
const SCRIPT = resolve(WORTEL, "scripts/klantportaal-overnemen.mjs");
const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  NIEUW: string[];
  SAMENVOEGEN: string[];
  plan: (o: { app: string; template: string }) => {
    weg: "A" | "B";
    heeftAppMetDatabase: boolean;
    routes: string[];
    bestanden: Array<{ pad: string; soort: string; d?: { n: number; oordeel: string } }>;
  };
  overnemen: (o: { app: string; template: string }) => string[];
  nakijken: (app: string) => { voor: string[]; weg: string[] };
};

const tijdelijk: string[] = [];
afterAll(() => {
  for (const map of tijdelijk) rmSync(map, { recursive: true, force: true });
});

function git(map: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: map, encoding: "utf8" });
}

function repo(bestanden: Record<string, string>): string {
  const map = mkdtempSync(join(tmpdir(), "klantportaal-overnemen-"));
  tijdelijk.push(map);
  git(map, "init", "-q", "-b", "main");
  git(map, "config", "user.email", "test@example.invalid");
  git(map, "config", "user.name", "Test");
  git(map, "config", "commit.gpgsign", "false");
  schrijf(map, bestanden);
  return map;
}

function schrijf(map: string, bestanden: Record<string, string | null>) {
  for (const [pad, inhoud] of Object.entries(bestanden)) {
    if (inhoud === null) {
      rmSync(join(map, pad), { force: true });
      continue;
    }
    mkdirSync(dirname(join(map, pad)), { recursive: true });
    writeFileSync(join(map, pad), bron(inhoud));
  }
  git(map, "add", "-A");
  git(map, "commit", "-q", "--allow-empty", "-m", "stap");
}

const lees = (map: string, pad: string) => readFileSync(join(map, pad), "utf8");
/**
 * De bestanden van de nagebootste template en apps schrijven hun imports met ~/; schrijf() maakt
 * er @/ van. Zo ziet tests/unit/template-afhankelijk.test.ts ze niet aan voor imports van deze test.
 */
const bron = (tekst: string) => tekst.replaceAll('"~/', '"@/');
const ROUTES = "src/features/auth/app-met-database.tsx";
const ROUTES_V1 = bron(
  [
    'import { ItemsPage } from "~/features/items/items-page";',
    "export default function AppMetDatabase() {",
    "  return (",
    "    <Routes>",
    '      <Route path="/login" element={<LoginPage />} />',
    '      <Route path="/" element={<ItemsPage />} />',
    "    </Routes>",
    "  );",
    "}",
    "",
  ].join("\n"),
);
const ROUTES_V2 = bron(
  ROUTES_V1.replace("    <Routes>", "    <Routes>\n      <Route element={<Nieuw />} />").replace(
    "export default",
    'import { Nieuw } from "~/features/auth/mailcode";\nexport default',
  ),
);
const APP_V1 = bron(
  [
    'import { lazy, Suspense } from "react";',
    'import { heeftDatabase } from "~/lib/env";',
    'const AppMetDatabase = lazy(() => import("~/features/auth/app-met-database"));',
    "export function App() {",
    "  return heeftDatabase ? (",
    "    <Suspense fallback={<p>Bezig met laden…</p>}>",
    "      <AppMetDatabase />",
    "    </Suspense>",
    "  ) : null;",
    "}",
    "",
  ].join("\n"),
);
const MAIN_V1 = bron('import "~/index.css";\nrender(<App />);\n');

/** Een template met stack-v1 en stack-v2; in v2 verhuist de start naar src/start.tsx. */
function template(): string {
  const t = repo({
    ".claude/stack-version": "1\n",
    [ROUTES]: ROUTES_V1,
    "src/main.tsx": MAIN_V1,
    "src/App.tsx": APP_V1,
  });
  git(t, "tag", "stack-v1");
  schrijf(t, {
    ".claude/stack-version": "2\n",
    [ROUTES]: ROUTES_V2,
    "src/main.tsx": 'import("~/start");\n',
    "src/start.tsx": MAIN_V1,
    "src/features/auth/mailcode.ts":
      'import { hulp } from "~/lib/hulpje";\nexport const Nieuw = () => hulp;\n',
    "src/lib/hulpje.ts": "export const hulp = 1;\n",
  });
  git(t, "tag", "stack-v2");
  return t;
}

/** Alleen in de template zelf (zoals guard-template): een app heeft deze bestanden niet allemaal. */
function inDeTemplate(): boolean {
  let repo = process.env.GITHUB_REPOSITORY ?? "";
  if (!repo) {
    try {
      repo = git(WORTEL, "remote", "get-url", "origin").trim();
    } catch {
      return false;
    }
  }
  return /\/(?:app-template-tier[12]|stack-template(?:-cloudflare|-light)?)(?:\.git)?$/.test(repo);
}

describe("klantportaal-overnemen: de lijsten kloppen met de template", () => {
  it.runIf(inDeTemplate())("elk bestand dat het script noemt, staat in de template", () => {
    for (const pad of [...mod.NIEUW, ...mod.SAMENVOEGEN]) {
      expect(existsSync(join(WORTEL, pad)), pad).toBe(true);
    }
  });
});

describe("klantportaal-overnemen: weg A, de indeling van de template", () => {
  const t = template();
  const app = repo({
    ".claude/stack-version": "2\n",
    // De eigen code van de app is van versie 1, met een eigen route erbij.
    [ROUTES]: ROUTES_V1.replace(
      "    </Routes>",
      '      <Route path="/bestellingen" element={<Bestellingen />} />\n    </Routes>',
    ),
    "src/main.tsx": `${MAIN_V1}zetThema();\n`,
    "src/App.tsx": lees(t, "src/App.tsx"),
  });

  it("kijkt eerst, en kiest de versie waar de app van is als basis", () => {
    const p = mod.plan({ app, template: t });
    expect(p.weg).toBe("A");
    expect(p.heeftAppMetDatabase).toBe(true);
    expect(p.routes).toEqual([ROUTES]);
    const routes = p.bestanden.find((b) => b.pad === ROUTES);
    expect(routes?.soort).toBe("samenvoegen");
    expect(routes?.d).toMatchObject({ n: 1, oordeel: "weinig" });
    expect(p.bestanden.find((b) => b.pad === "src/start.tsx")).toMatchObject({
      soort: "samenvoegen",
      d: { n: 1 },
    });
    expect(git(app, "status", "--porcelain")).toBe("");
  });

  it("voegt samen: het nieuwe van de template en de eigen route, en volgt de imports", () => {
    const uit = mod.overnemen({ app, template: t });
    const routes = lees(app, ROUTES);
    expect(routes).toContain("<Route element={<Nieuw />} />");
    expect(routes).toContain('path="/bestellingen"');
    expect(routes).not.toContain("<<<<<<<");
    expect(lees(app, "src/start.tsx")).toContain("zetThema();");
    expect(lees(app, "src/main.tsx")).toBe(bron('import("~/start");\n'));
    expect(lees(app, "src/lib/hulpje.ts")).toBe("export const hulp = 1;\n");
    expect(uit).toContain("nieuw: src/features/auth/mailcode.ts");
    expect(uit).toContain("nieuw (nodig voor src/features/auth/mailcode.ts): src/lib/hulpje.ts");
    expect(mod.nakijken(app).weg).toEqual([]);
  });

  it("schrijft niet over werk dat nog niet gecommit is", () => {
    expect(() => mod.overnemen({ app, template: t })).toThrow(/nog niet gecommit/);
  });
});

describe("klantportaal-overnemen: weg B, een eigen indeling", () => {
  const t = template();
  const app = repo({
    ".claude/stack-version": "2\n",
    // Geen app-met-database.tsx: de routes staan in App.tsx, met een eigen hook.
    "src/App.tsx": [
      'import { useAuth } from "~/hooks/use-auth";',
      "export function App() {",
      "  const { session } = useAuth();",
      "  return (",
      "    <Routes>",
      '      <Route path="/" element={<Bestellingen session={session} />} />',
      '      <Route path="/klanten/:id/*" element={<KlantDetail />} />',
      "    </Routes>",
      "  );",
      "}",
      "",
    ].join("\n"),
    "src/main.tsx":
      'import React from "react";\nimport { zetThema } from "~/lib/thema";\nzetThema();\nReactDOM.createRoot(root).render(<App />);\n',
  });

  it("zegt weg B, en voegt een eigen indeling niet half samen", () => {
    const p = mod.plan({ app, template: t });
    expect(p.weg).toBe("B");
    expect(p.heeftAppMetDatabase).toBe(false);
    expect(p.routes).toEqual(["src/App.tsx"]);
    const soort = Object.fromEntries(p.bestanden.map((b) => [b.pad, b.soort]));
    expect(soort[ROUTES]).toBe("MET DE HAND");
    expect(soort["src/App.tsx"]).toBe("MET DE HAND");
    expect(soort["src/start.tsx"]).toBe("MET DE HAND");
  });

  it("neemt de versie van de template, meldt het voorbeeldscherm, en ziet de verdwenen routes", () => {
    const uit = mod.overnemen({ app, template: t });
    expect(lees(app, ROUTES)).toBe(ROUTES_V2);
    expect(lees(app, "src/App.tsx")).toBe(lees(t, "src/App.tsx"));
    expect(uit.join("\n")).toMatch(
      /MET DE HAND: src\/features\/auth\/app-met-database\.tsx.*src\/App\.tsx/,
    );
    expect(uit.join("\n")).toMatch(
      /importeert src\/features\/items\/items-page, een voorbeeldscherm/,
    );
    expect(existsSync(join(app, "src/features/items/items-page.tsx"))).toBe(false);
    // "/" staat ook in de versie van de template (met het voorbeeldscherm); dat meldt overnemen.
    expect(mod.nakijken(app).weg).toEqual(["/klanten/:id/*"]);
  });
});
