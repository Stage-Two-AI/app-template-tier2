import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Code van de template mag alleen leunen op bestanden die er na updaten zeker zijn. Bij de test
 * van versie 39 importeerde e2e/onderdelen.spec.ts (nieuw van de template) e2e/stack-config.ts,
 * een bestand van het project dat oudere apps niet hadden: de typecontrole van de update-PR was
 * rood. Deze test maakt zoiets rood in de template, voordat een app het merkt.
 *
 * Elk bestand waar een bestand van de template naar verwijst (een import, of `node scripts/...`
 * in een workflow of in package.json) is zelf van de template (`vervangen`), of updaten zet het
 * neer als het ontbreekt (`alsHetOntbreekt` in .claude/stack-manifest.json, of
 * DOOR_UPDATEN_GEVULD hieronder), of het is de app zelf (DE_APP_ZELF). Voor dat laatste is een
 * reden nodig die deze test ook nagaat.
 *
 * Een bestand uit `alsHetOntbreekt` is alleen in de template zelf van de template. In een app is
 * het van het project, en mag het naar eigen bestanden van de app verwijzen (bij de test van
 * versie 41 importeerde worker/env.ts van een app `./bestanden`, en was de update-PR rood). Die
 * bestanden controleert deze test dus alleen in de template.
 *
 * Deze test is van de template en komt met elke versie mee.
 */
const WORTEL = resolve(__dirname, "../..");

/**
 * Updaten zet dit neer, gevuld uit de routes van de app (lib/projectbestanden.mjs in de plugin,
 * sinds versie 39). Het bestand van de template is alleen een voorbeeld.
 */
const DOOR_UPDATEN_GEVULD = new Set(["src/onderdelen.ts"]);

/** In tier 2 leunt geen code van de template op de app zelf. */
const DE_APP_ZELF = new Set<string>();

type Manifest = {
  vanDeTemplate: {
    vervangen: string[];
    sleutelsSamenvoegen?: Record<string, string[]>;
    tussenMarkeringen?: Record<string, string>;
    alsHetOntbreekt?: string[];
  };
  vanHetProject: string[];
};

const manifest: Manifest = JSON.parse(
  readFileSync(join(WORTEL, ".claude/stack-manifest.json"), "utf8"),
);
const van = manifest.vanDeTemplate;
const vanDeTemplate = new Set([
  ...van.vervangen,
  ...Object.keys(van.sleutelsSamenvoegen ?? {}),
  ...Object.keys(van.tussenMarkeringen ?? {}),
]);
const alsHetOntbreekt = new Set(van.alsHetOntbreekt ?? []);
const zeker = new Set([
  ...vanDeTemplate,
  ...alsHetOntbreekt,
  ...DOOR_UPDATEN_GEVULD,
  ...DE_APP_ZELF,
]);

/** De template zelf, of de kopie ervan bij een klant; herkend zoals guard-template dat doet. */
function isDeTemplate(repo: string): boolean {
  return /\/(?:app-template-tier[12]|stack-template(?:-cloudflare|-light)?)(?:\.git)?$/.test(repo);
}

const repo =
  process.env.GITHUB_REPOSITORY ??
  (() => {
    try {
      return execFileSync("git", ["remote", "get-url", "origin"], {
        cwd: WORTEL,
        encoding: "utf8",
      }).trim();
    } catch {
      return "";
    }
  })();
const inDeTemplate = isDeTemplate(repo);

const IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](\.{1,2}\/[^"']+|@\/[^"']+)["']/g;
const NODE_SCRIPT = /\bnode\s+(scripts\/[\w./-]+\.mjs)\b/g;
const EXTENSIES = ["", ".ts", ".tsx", ".mjs", ".js", ".json", "/index.ts", "/index.tsx"];

/** Het bestand waar een import op uitkomt, of null als het in de template niet bestaat. */
function doelVan(vanuit: string, spec: string): string | null {
  const basis = spec.startsWith("@/")
    ? join("src", spec.slice(2))
    : normalize(join(dirname(vanuit), spec));
  const kandidaten = [...EXTENSIES.map((e) => basis + e), basis.replace(/\.js$/, ".ts")];
  return kandidaten.find((k) => existsSync(join(WORTEL, k))) ?? null;
}

/** Alle verwijzingen uit één bestand: [doel, regel uit de bron]. */
function verwijzingen(pad: string): Array<[string | null, string]> {
  const tekst = readFileSync(join(WORTEL, pad), "utf8");
  const uit: Array<[string | null, string]> = [];
  if (/\.(m?[jt]sx?)$/.test(pad)) {
    for (const m of tekst.matchAll(IMPORT)) uit.push([doelVan(pad, m[1] ?? ""), m[1] ?? ""]);
  }
  if (/\.(ya?ml|json)$/.test(pad)) {
    for (const m of tekst.matchAll(NODE_SCRIPT)) {
      const doel = m[1] ?? "";
      uit.push([existsSync(join(WORTEL, doel)) ? doel : null, doel]);
    }
  }
  return uit;
}

describe("code van de template leunt alleen op bestanden die er na updaten zeker zijn", () => {
  const bronnen = [...vanDeTemplate, ...(inDeTemplate ? alsHetOntbreekt : [])]
    .filter((p) => existsSync(join(WORTEL, p)))
    .sort();

  it("elke verwijzing komt uit op een bestand van de template, of een dat updaten neerzet", () => {
    const fout: string[] = [];
    for (const bron of bronnen) {
      for (const [doel, spec] of verwijzingen(bron)) {
        if (doel === null) fout.push(`${bron} -> ${spec} (bestaat niet in de template)`);
        else if (!zeker.has(doel)) fout.push(`${bron} -> ${doel}`);
      }
    }
    expect(
      fout,
      "zet het doel in vervangen (als het van de template is) of in alsHetOntbreekt (als het van het project blijft)",
    ).toEqual([]);
  });

  it("controleert de bestanden uit alsHetOntbreekt alleen in de template zelf", () => {
    expect(isDeTemplate("Stage-Two-AI/app-template-tier1")).toBe(true);
    expect(isDeTemplate("https://github.com/Klant/app-template-tier2.git")).toBe(true);
    expect(isDeTemplate("Stage-Two-AI/fotografie")).toBe(false);
    expect(isDeTemplate("")).toBe(false);
  });

  it("alsHetOntbreekt: elk bestand staat in de template en blijft van het project", () => {
    for (const pad of alsHetOntbreekt) {
      expect(existsSync(join(WORTEL, pad)), pad).toBe(true);
      expect(vanDeTemplate.has(pad), `${pad} staat ook in vervangen`).toBe(false);
    }
  });

  it("DE_APP_ZELF is echt de app: wrangler.jsonc start hem", () => {
    if (DE_APP_ZELF.size === 0) return;
    const wrangler = readFileSync(join(WORTEL, "wrangler.jsonc"), "utf8");
    const main = /"main"\s*:\s*"([^"]+)"/.exec(wrangler)?.[1];
    expect([...DE_APP_ZELF]).toEqual([main]);
  });
});
