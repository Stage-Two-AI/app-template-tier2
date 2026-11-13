#!/usr/bin/env node
/**
 * Stap 3 van docs/routes/klantportaal.md: de bestanden voor een klantportaal uit de template
 * overnemen in een bestaande app. Draai het in de map van de app, met een kloon van de template
 * op de versie van de app:
 *
 *   node scripts/klantportaal-overnemen.mjs --template <map>              alleen kijken
 *   node scripts/klantportaal-overnemen.mjs --template <map> --overnemen  ook doen
 *
 * Kijken (wijzigt niets): per bestand dat de app al heeft, hoeveel het afwijkt van de template.
 * Niet alleen van versie 42: een update raakt src/ nooit, dus de eigen code van een app kan van
 * elke eerdere versie zijn, of van een eigen indeling. Daarom vergelijkt het script elk bestand
 * met dat bestand op elke tag stack-v<n> van de template en neemt de dichtstbijzijnde als basis:
 * "gelijk", "weinig" of "veel" anders. Daarbij: heeft de app src/features/auth/app-met-database.tsx,
 * en in welke bestanden staan de routes van de app.
 *
 * Overnemen, per bestand:
 *   nieuw          de app heeft het niet: de versie van de template;
 *   samengevoegd   "gelijk" of "weinig": samenvoegen in drie richtingen met de dichtstbijzijnde
 *                  versie als basis (git merge-file). Bij CONFLICT staan de plekken tussen
 *                  <<<<<<< app en >>>>>>> template;
 *   MET DE HAND    "veel" (of het bestand ontbreekt waar de app het zou moeten hebben): de versie
 *                  van de template in zijn geheel. Wat de app er zelf in had, staat nog in git
 *                  (`git diff HEAD -- <pad>`) en zet de agent er met de hand weer in.
 * En: een bestand dat een overgenomen bestand importeert (`@/...`) en dat de app mist, komt
 * mee uit de template, behalve de voorbeeldschermen van de template (src/features/items/ en
 * src/features/start/): die meldt het, want daar hoort het eigen scherm van de app.
 *
 * Het script schrijft alleen over bestanden zonder eigen, nog niet gecommitte wijzigingen, en
 * stopt anders vóór het iets doet. Samenvoegen blijft verder werk van de agent.
 *
 * Dit script is van de template en komt met elke versie mee.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Bestanden die de app nog niet heeft: kopiëren, nooit overschrijven. */
export const NIEUW = [
  "supabase/templates/inlogcode.html",
  "src/features/auth/inlog-met-code.tsx",
  "src/features/auth/inlog-met-code.test.tsx",
  "src/features/auth/mailcode.ts",
  "src/features/auth/mailcode.test.ts",
  "src/features/auth/use-mailcode.ts",
  "src/features/auth/robotcontrole.ts",
  "src/features/auth/robotcontrole.test.ts",
  "src/features/auth/medewerkersessie.tsx",
  "src/features/auth/medewerkersessie.test.tsx",
  "src/features/auth/app-klantportaal.test.tsx",
  "src/features/auth/portaaltoegang.tsx",
  "src/features/auth/portaaltoegang.test.tsx",
  "src/features/auth/wacht-op-goedkeuring.tsx",
  "src/features/auth/wacht-op-goedkeuring.test.tsx",
  "src/features/auth/alleen-medewerker.tsx",
  "src/features/auth/alleen-medewerker.test.tsx",
  "src/features/auth/klanten-goedkeuren.tsx",
  "src/features/auth/klanten-goedkeuren.test.tsx",
  "src/lib/startfout.ts",
  "src/lib/startfout.test.ts",
  "src/main.test.ts",
  "tests/lib/mailvanger.ts",
  "tests/rls/lib/sessies.ts",
  "tests/rls/lib/inlogdienst-nep.ts",
  "tests/rls/klantportaal.test.ts",
  "tests/rls/inlogmail.test.ts",
  "tests/unit/klantportaal-lokaal.test.ts",
  "e2e/klantportaal.spec.ts",
];

/** Bestanden die de app meestal al heeft, met een eigen inhoud: samenvoegen. */
export const SAMENVOEGEN = [
  "src/App.tsx",
  "src/lib/env.ts",
  "src/lib/env.test.ts",
  "src/features/auth/inlogdienst.ts",
  "src/features/auth/inlogdienst.test.ts",
  "src/features/auth/login-page.tsx",
  "src/features/auth/login-page.test.tsx",
  "src/features/auth/app-met-database.tsx",
  "src/features/auth/app-met-database.test.tsx",
  "playwright.config.ts",
  "supabase/config.toml",
  ".env.example",
  ".gitignore",
];

export const ROUTES_BESTAND = "src/features/auth/app-met-database.tsx";
/** Voorbeeldschermen van de template: nooit vanzelf meenemen. */
const VOORBEELD = /^src\/features\/(?:items|start)\//;

const RUIM = 64 * 1024 * 1024;

function git(cwd, args, opties = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: RUIM, ...opties });
}

function probeer(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

function leesArgs(argv) {
  const uit = { template: null, overnemen: false, app: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--template") uit.template = argv[++i] ?? null;
    else if (argv[i] === "--overnemen") uit.overnemen = true;
    else if (argv[i] === "--app") uit.app = argv[++i] ?? uit.app;
    else throw new Error(`onbekend argument ${argv[i]}`);
  }
  if (!uit.template) throw new Error("geef de map van de template mee: --template <map>");
  return { ...uit, template: resolve(uit.template), app: resolve(uit.app) };
}

function versieVan(map) {
  return Number(probeer(() => readFileSync(join(map, ".claude/stack-version"), "utf8").trim()));
}

/** De tags stack-v<n> van de template tot en met `tot`, nieuwste eerst. */
function tags(template, tot) {
  return git(template, ["tag", "--list", "stack-v*"])
    .split("\n")
    .map((t) => ({ tag: t.trim(), n: Number(/^stack-v(\d+)$/.exec(t.trim())?.[1]) }))
    .filter((t) => Number.isInteger(t.n) && t.n <= tot)
    .sort((a, b) => b.n - a.n);
}

/**
 * Wat er verschilt tussen de template (`a`) en de app (`b`): `erbij` (regels die de app zelf
 * heeft) en `eraf` (regels van de template die de app niet heeft).
 */
function verschil(a, b, werk) {
  if (a === b) return { erbij: 0, eraf: 0 };
  const pa = join(werk, "a");
  const pb = join(werk, "b");
  writeFileSync(pa, a);
  writeFileSync(pb, b);
  let uit;
  try {
    uit = git(werk, ["diff", "--no-index", "--numstat", "--", pa, pb]);
  } catch (fout) {
    // git diff --no-index geeft 1 als er verschil is.
    uit = String(fout.stdout ?? "");
  }
  const [erbij = "0", eraf = "0"] = uit.trim().split(/\s+/);
  return { erbij: Number(erbij) || 0, eraf: Number(eraf) || 0 };
}

/**
 * De versie van de template die het dichtst bij het bestand van de app ligt:
 * `{ tag, n, erbij, eraf, oordeel }`, of null als de template het bestand op geen enkele tag had.
 *
 * Het oordeel kijkt naar `eraf`: regels van die versie die de app NIET heeft. Eigen regels erbij
 * (eigen routes, eigen variabelen) zijn voor samenvoegen geen probleem. Ontbreken er veel regels
 * van de template, dan is het bestand van een andere indeling, en dan ziet samenvoegen het
 * ontbrekende als "bewust weggehaald" en neemt het de nieuwe onderdelen maar half over.
 * Weinig is hoogstens 10 regels of 15 procent van die versie.
 */
export function dichtstbij({ template, pad, tekst, lijst, werk }) {
  const gezien = new Map();
  let beste = null;
  for (const { tag, n } of lijst) {
    const blob = probeer(() =>
      git(template, ["rev-parse", `${tag}:${pad}`], { stdio: ["ignore", "pipe", "ignore"] }).trim(),
    );
    if (!blob) continue;
    let v = gezien.get(blob);
    if (v === undefined) {
      const inhoud = git(template, ["cat-file", "blob", blob]);
      v = { ...verschil(inhoud, tekst, werk), lengte: inhoud.split("\n").length };
      gezien.set(blob, v);
    }
    const som = v.erbij + v.eraf;
    if (!beste || som < beste.erbij + beste.eraf) beste = { tag, n, ...v };
    if (som === 0) break;
  }
  if (!beste) return null;
  const grens = Math.max(10, Math.round(beste.lengte * 0.15));
  const oordeel =
    beste.erbij + beste.eraf === 0 ? "gelijk" : beste.eraf <= grens ? "weinig" : "veel";
  return { tag: beste.tag, n: beste.n, erbij: beste.erbij, eraf: beste.eraf, oordeel };
}

/** Bestanden in src/ (geen tests) met een router of routes. */
function routesIn(app) {
  const uit = [];
  const loop = (map) => {
    for (const naam of readdirSync(join(app, map))) {
      const pad = `${map}/${naam}`;
      if (statSync(join(app, pad)).isDirectory()) loop(pad);
      else if (/\.(tsx?|jsx?)$/.test(naam) && !/\.test\./.test(naam)) {
        const tekst = readFileSync(join(app, pad), "utf8");
        if (/<Routes\b|<Route\b|createBrowserRouter|useRoutes\(/.test(tekst)) uit.push(pad);
      }
    }
  };
  if (existsSync(join(app, "src"))) loop("src");
  return uit.sort();
}

/** De `@/...`-imports in een tekst, als paden in de app die bestaan of zouden moeten bestaan. */
function importsVan(tekst) {
  return [...tekst.matchAll(/from\s+["']@\/([^"']+)["']|import\(\s*["']@\/([^"']+)["']\s*\)/g)].map(
    (m) => `src/${m[1] ?? m[2]}`,
  );
}

function bestaatMetExtensie(map, basis) {
  for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    if (existsSync(join(map, basis + ext)) && statSync(join(map, basis + ext)).isFile())
      return basis + ext;
  }
  return null;
}

/** Wat het script met elk bestand zou doen; wijzigt niets. */
export function plan({ app, template }) {
  const versieApp = versieVan(app);
  const versieTemplate = versieVan(template);
  const lijst = tags(template, versieTemplate);
  const werk = mkdtempSync(join(tmpdir(), "klantportaal-"));
  const bestanden = [];
  try {
    for (const pad of NIEUW) {
      if (!existsSync(join(template, pad))) continue;
      if (!existsSync(join(app, pad))) bestanden.push({ pad, soort: "nieuw" });
      else {
        const gelijk =
          readFileSync(join(app, pad), "utf8") === readFileSync(join(template, pad), "utf8");
        bestanden.push({ pad, soort: gelijk ? "al gelijk" : "STAAT ER AL" });
      }
    }
    // src/main.tsx: de app start sinds versie 43 in src/start.tsx; main.tsx laadt die.
    const startNieuw =
      !existsSync(join(app, "src/start.tsx")) && existsSync(join(app, "src/main.tsx"));
    const samen = [...SAMENVOEGEN, ...(startNieuw ? [] : ["src/start.tsx", "src/main.tsx"])];
    for (const pad of samen) {
      if (!existsSync(join(template, pad))) continue;
      if (!existsSync(join(app, pad))) {
        bestanden.push({
          pad,
          soort: pad === ROUTES_BESTAND ? "MET DE HAND" : "nieuw",
          ontbreekt: true,
        });
        continue;
      }
      const d = dichtstbij({
        template,
        pad,
        tekst: readFileSync(join(app, pad), "utf8"),
        lijst,
        werk,
      });
      bestanden.push({ pad, soort: d && d.oordeel !== "veel" ? "samenvoegen" : "MET DE HAND", d });
    }
    if (startNieuw) {
      const d = dichtstbij({
        template,
        pad: "src/main.tsx",
        tekst: readFileSync(join(app, "src/main.tsx"), "utf8"),
        lijst,
        werk,
      });
      bestanden.push({
        pad: "src/start.tsx",
        van: "src/main.tsx",
        soort: d && d.oordeel !== "veel" ? "samenvoegen" : "MET DE HAND",
        d,
      });
      bestanden.push({ pad: "src/main.tsx", soort: "van de template", vervangt: true });
    }
  } finally {
    rmSync(werk, { recursive: true, force: true });
  }
  const metDeHand = bestanden.filter((b) => b.soort === "MET DE HAND" || b.soort === "STAAT ER AL");
  return {
    versieApp,
    versieTemplate,
    heeftAppMetDatabase: existsSync(join(app, ROUTES_BESTAND)),
    routes: routesIn(app),
    bestanden,
    weg: metDeHand.length === 0 ? "A" : "B",
  };
}

function beschrijf(b) {
  if (b.d) {
    const wat =
      b.d.oordeel === "gelijk"
        ? `gelijk aan versie ${b.d.n}`
        : `dichtst bij versie ${b.d.n}: ${b.d.eraf} regels daarvan ontbreken in de app, ${b.d.erbij} eigen regels erbij`;
    return `${b.d.oordeel}, ${wat}${b.van ? ` (uit ${b.van})` : ""}`;
  }
  if (b.ontbreekt && b.pad === ROUTES_BESTAND)
    return "ontbreekt: de app heeft een eigen indeling; de routes van de app gaan hierin";
  if (b.ontbreekt) return "ontbreekt in de app";
  if (b.vervangt) return "laadt voortaan src/start.tsx";
  if (b.soort === "STAAT ER AL") return "de app heeft een eigen bestand met deze naam";
  return "";
}

export function tekstVanPlan(p) {
  const regels = [
    `Klantportaal overnemen: de app staat op versie ${p.versieApp}, de template op versie ${p.versieTemplate}.`,
  ];
  if (p.versieApp !== p.versieTemplate) {
    regels.push(
      `LET OP: zet de template op de versie van de app (git -C <template> checkout stack-v${p.versieApp}).`,
    );
  }
  regels.push(
    `${ROUTES_BESTAND}: ${p.heeftAppMetDatabase ? "staat er" : "ONTBREEKT"}`,
    `Routes van de app staan in: ${p.routes.length ? p.routes.join(", ") : "(niets gevonden)"}`,
    "",
  );
  const breed = Math.max(...p.bestanden.map((b) => b.soort.length));
  for (const b of p.bestanden) {
    const uitleg = beschrijf(b);
    regels.push(`  ${b.soort.padEnd(breed)}  ${b.pad}${uitleg ? `  (${uitleg})` : ""}`);
  }
  regels.push("");
  regels.push(
    p.weg === "A"
      ? "Weg A: de app heeft de indeling van de template. Draai dit opnieuw met --overnemen."
      : "Weg B: de app heeft een oudere of eigen indeling. Bij MET DE HAND neemt --overnemen de versie van de template in zijn geheel; daarna zet je er de eigen routes en imports van de app weer in (git show HEAD:<pad>). Leg de bouwer eerst uit wat er verandert.",
  );
  return regels.join("\n");
}

/** Doet wat het plan zegt. Geeft per bestand een regel. */
export function overnemen({ app, template }, p = plan({ app, template })) {
  if (p.versieApp !== p.versieTemplate) {
    throw new Error(
      `de template staat op versie ${p.versieTemplate} en de app op ${p.versieApp}: zet de template eerst op stack-v${p.versieApp}`,
    );
  }
  const vuil = probeer(() =>
    git(app, ["status", "--porcelain", "--", ...p.bestanden.map((b) => b.pad)]).trim(),
  );
  if (vuil)
    throw new Error(
      `deze bestanden hebben wijzigingen die nog niet gecommit zijn; commit of zet ze terug en draai opnieuw:\n${vuil}`,
    );
  const uit = [];
  const geschreven = [];
  const kopieer = (pad) => {
    mkdirSync(dirname(join(app, pad)), { recursive: true });
    copyFileSync(join(template, pad), join(app, pad));
    geschreven.push(pad);
  };
  for (const b of p.bestanden) {
    if (b.soort === "nieuw" || b.soort === "van de template") {
      kopieer(b.pad);
      uit.push(`${b.soort === "nieuw" ? "nieuw" : "vervangen"}: ${b.pad}`);
    } else if (b.soort === "MET DE HAND" && b.ontbreekt) {
      kopieer(b.pad);
      uit.push(
        `MET DE HAND: ${b.pad} is nieuw uit de template, met het voorbeeldscherm van de template. Zet er de routes van de app in (nu in: ${p.routes.join(", ") || "zoek ze op"})`,
      );
    } else if (b.soort === "MET DE HAND") {
      kopieer(b.pad);
      uit.push(
        `MET DE HAND: ${b.pad} is nu de versie van de template; zet er weer in wat de app zelf had (git show HEAD:${b.van ?? b.pad})`,
      );
    } else if (b.soort === "samenvoegen") {
      const eigen = readFileSync(join(app, b.van ?? b.pad), "utf8");
      const basis = git(template, ["show", `${b.d.tag}:${b.van ?? b.pad}`]);
      const doel = join(app, b.pad);
      writeFileSync(doel, eigen);
      const basisPad = `${doel}.basis`;
      writeFileSync(basisPad, basis);
      let conflict = false;
      try {
        git(app, [
          "merge-file",
          "-L",
          "app",
          "-L",
          `versie-${b.d.n}`,
          "-L",
          "template",
          doel,
          basisPad,
          join(template, b.pad),
        ]);
      } catch {
        conflict = true;
      } finally {
        rmSync(basisPad, { force: true });
      }
      geschreven.push(b.pad);
      uit.push(
        `${conflict ? "CONFLICT" : "samengevoegd"}: ${b.pad} (basis versie ${b.d.n}${b.van ? `, uit ${b.van}` : ""})`,
      );
    } else if (b.soort === "STAAT ER AL") {
      uit.push(
        `STAAT ER AL: ${b.pad}: vergelijk met de template (diff ${b.pad} <template>/${b.pad}) en neem de versie van de template over, met wat de app er zelf in had`,
      );
    }
  }
  // Wat de overgenomen bestanden importeren en de app mist.
  const gedaan = new Set(geschreven);
  for (let i = 0; i < geschreven.length; i++) {
    const pad = geschreven[i];
    if (!/\.(tsx?)$/.test(pad)) continue;
    for (const basis of importsVan(readFileSync(join(app, pad), "utf8"))) {
      if (bestaatMetExtensie(app, basis)) continue;
      const inTemplate = bestaatMetExtensie(template, basis);
      if (!inTemplate || gedaan.has(inTemplate)) continue;
      gedaan.add(inTemplate);
      if (VOORBEELD.test(inTemplate)) {
        uit.push(
          `MET DE HAND: ${pad} importeert ${inTemplate}, een voorbeeldscherm van de template. Zet daar het eigen scherm van de app in`,
        );
        continue;
      }
      kopieer(inTemplate);
      uit.push(`nieuw (nodig voor ${pad}): ${inTemplate}`);
    }
  }
  return uit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const arg = leesArgs(process.argv.slice(2));
    if (!existsSync(join(arg.template, ".git")))
      throw new Error(`${arg.template} is geen kloon van de template`);
    const p = plan(arg);
    console.log(tekstVanPlan(p));
    if (arg.overnemen) {
      console.log("");
      for (const regel of overnemen(arg, p)) console.log(regel);
      console.log("");
      console.log(
        "Zoek naar resten van conflicten: grep -rln '^<<<<<<<' src tests e2e supabase playwright.config.ts .env.example .gitignore",
      );
    }
  } catch (fout) {
    console.error(`✗ ${fout.message}`);
    process.exit(1);
  }
}
