import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Een update moet groen zijn in een app, niet alleen in de template. In uitgave 42
 * (tests/unit/template-afhankelijk.test.ts) en weer in 43 (tests/unit/rls-regels.test.ts las de
 * migraties van de app en verwachtte die van de template) was een test van de template groen in
 * de template en rood in elke app. Pas de generale repetitie op kopieën van echte apps zag het.
 *
 * Deze test bootst daarom een afgeleide app na, zoals /stagetwo-tier2:updaten hem achterlaat:
 * de boom van de vorige uitgave (git archive stack-vN), met daaroverheen ALLEEN de bestanden uit
 * .claude/stack-manifest.json van de huidige stand (vervangen: vervangen; alsHetOntbreekt: alleen
 * als het ontbreekt; package.json: de sleutels samengevoegd; AGENTS.md: tussen de markeringen).
 * Alles van het project blijft van de vorige uitgave: src/, supabase/, stack.config.json. De app
 * krijgt een eigen tabel, zodat "dit is niet de template" ook voor de migraties waar is. Daarin
 * draaien de typecontrole, de lint, de unittests en de guards die geen database nodig hebben.
 *
 * Alleen in de template zelf (herkend zoals guard-template dat doet). In een app slaat hij over:
 * daar is niets na te bootsen. Kan hij in de template niet draaien (geen git, geen vorige tag),
 * dan is dat in CI rood, niet stil.
 *
 * Deze test is van de template en komt met elke versie mee.
 */
const WORTEL = resolve(__dirname, "../..");
const RUIME_BUFFER = 256 * 1024 * 1024;

type Manifest = {
  stackVersion: number;
  vanDeTemplate: {
    vervangen: string[];
    sleutelsSamenvoegen?: Record<string, string[]>;
    tussenMarkeringen?: Record<string, string>;
    alsHetOntbreekt?: string[];
  };
  nietMeenemen?: string[];
};

function isDeTemplate(repo: string): boolean {
  return /\/(?:app-template-tier[12]|stack-template(?:-cloudflare|-light)?)(?:\.git)?$/.test(repo);
}

function git(args: string[], cwd = WORTEL): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: RUIME_BUFFER }).trim();
}

function probeer(args: string[]): string | null {
  try {
    return git(args);
  } catch {
    return null;
  }
}

const repo = process.env.GITHUB_REPOSITORY ?? probeer(["remote", "get-url", "origin"]) ?? "";
const inDeTemplate = isDeTemplate(repo);

/**
 * De vorige uitgave: de hoogste tag stack-vN met N tot en met de huidige versie die niet deze
 * commit zelf is. Vóór het ophogen van de versie is dat de tag van de huidige versie, erna die
 * van de vorige, en op de tag zelf ook de vorige.
 */
function vorigeTag(stackVersion: number): string | null {
  const head = probeer(["rev-parse", "HEAD"]);
  const tags = probeer(["tag", "--list", "stack-v*"]);
  if (!head || tags === null) return null;
  const kandidaten = tags
    .split("\n")
    .map((t) => ({ t, n: Number(/^stack-v(\d+)$/.exec(t.trim())?.[1]) }))
    .filter((k) => Number.isInteger(k.n) && k.n <= stackVersion)
    .sort((a, b) => b.n - a.n);
  for (const { t } of kandidaten) {
    if (probeer(["rev-parse", `${t}^{commit}`]) !== head) return t;
  }
  return null;
}

/** Een eenvoudige glob uit het manifest (`**`, `*`) als reguliere expressie. */
function globNaarRegex(glob: string): RegExp {
  const bron = glob
    .split("**")
    .map((deel) => deel.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
    .join(".*");
  return new RegExp(`^${bron}$`);
}

function alleBestanden(map: string, onder = ""): string[] {
  const uit: string[] = [];
  for (const naam of readdirSync(join(map, onder))) {
    const pad = onder ? `${onder}/${naam}` : naam;
    if (pad === ".git" || pad === "node_modules") continue;
    if (statSync(join(map, pad)).isDirectory()) uit.push(...alleBestanden(map, pad));
    else uit.push(pad);
  }
  return uit;
}

function kopieer(pad: string, naar: string) {
  mkdirSync(dirname(join(naar, pad)), { recursive: true });
  copyFileSync(join(WORTEL, pad), join(naar, pad));
}

/** Zoals voegSleutelsSamen in de plugin: eigen extra's blijven, de template wint per naam. */
function voegSleutelsSamen(eigen: string, template: string, welke: string[]): string {
  const uit = JSON.parse(eigen);
  const van = JSON.parse(template);
  for (const sleutel of welke) {
    if (!van[sleutel]) continue;
    const samen = { ...(uit[sleutel] ?? {}), ...van[sleutel] };
    uit[sleutel] = Object.fromEntries(
      Object.keys(samen)
        .sort()
        .map((k) => [k, samen[k]]),
    );
  }
  return `${JSON.stringify(uit, null, 2)}\n`;
}

function tussenMarkeringen(eigen: string, template: string, naam: string): string | null {
  const begin = `<!-- ${naam}:begin -->`;
  const eind = `<!-- ${naam}:end -->`;
  const knip = (t: string) => {
    const a = t.indexOf(begin);
    const b = t.indexOf(eind);
    return a === -1 || b === -1 || b < a ? null : { a, b: b + eind.length };
  };
  const hier = knip(eigen);
  const daar = knip(template);
  if (!hier || !daar) return null;
  return eigen.slice(0, hier.a) + template.slice(daar.a, daar.b) + eigen.slice(hier.b);
}

/** Een eigen tabel van de app, met row level security en een policy op de eigenaar. */
const EIGEN_MIGRATIE = `-- Een eigen tabel van deze app: niet het voorbeeld van de template.
create table public.bestellingen (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  omschrijving text not null
);

alter table public.bestellingen enable row level security;

create policy "bestellingen_eigen" on public.bestellingen
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());
`;

/** Bouwt de nagebootste app en geeft de map terug. */
function bouwAfgeleideApp(tag: string, manifest: Manifest): string {
  const map = mkdtempSync(join(tmpdir(), "afgeleide-app-"));
  const tar = join(map, "..", `${map.split("/").at(-1)}.tar`);
  try {
    git(["archive", "--format=tar", "-o", tar, tag]);
    execFileSync("tar", ["-xf", tar, "-C", map]);
  } finally {
    rmSync(tar, { force: true });
  }

  // Wat nooit naar een app gaat, en wat een echte app niet heeft: de migratie van het
  // klantportaal en het voorbeeld van de template staan in supabase/, en dat is van het project.
  const weg = (manifest.nietMeenemen ?? []).map(globNaarRegex);
  for (const pad of alleBestanden(map)) {
    if (weg.some((re) => re.test(pad)) || /^supabase\/migrations\/.*klantportaal/.test(pad)) {
      rmSync(join(map, pad));
    } else if (/^supabase\/migrations\/.*\.sql$/.test(pad)) {
      // De voorbeeldtabel items heet in een app anders.
      const sql = readFileSync(join(map, pad), "utf8");
      writeFileSync(
        join(map, pad),
        sql.replace(/\bitems\b/g, "notities").replace(/\bitems_/g, "notities_"),
      );
    }
  }
  writeFileSync(join(map, "supabase/migrations/20990101000000_bestellingen.sql"), EIGEN_MIGRATIE);
  // Elke sleutel die een app van de vorige uitgave in stack.config.json kan hebben: die van de
  // template en wat de plugin erin zet. Sinds uitgave 43 is een onbekende sleutel rood; een
  // bestaande app mag daar niet door rood worden.
  const config = JSON.parse(readFileSync(join(map, "stack.config.json"), "utf8"));
  writeFileSync(
    join(map, "stack.config.json"),
    `${JSON.stringify(
      {
        ...config,
        $opmerking: "eigen uitleg van de app",
        database: true,
        testmail: "test@voorbeeld.nl",
        open_tabellen: { bestellingen: "iedereen binnen ziet de bestellingen" },
        leesrollen: [],
        testdatabase: {
          project_ref: "abcdefghijklmnopqrst",
          anon_key: "sb_publishable_abcdefghijklm",
        },
      },
      null,
      2,
    )}\n`,
  );

  const inApp = (...args: string[]) => git(args, map);
  inApp("init", "-q", "-b", "main");
  inApp("config", "user.email", "test@example.invalid");
  inApp("config", "user.name", "Nagebootste app");
  inApp("config", "commit.gpgsign", "false");
  inApp("remote", "add", "origin", "https://github.com/Klant/eigen-app.git");
  inApp("add", "-A");
  inApp("commit", "-q", "-m", `app op ${tag}`);
  inApp("checkout", "-q", "-b", "stagetwo/update");

  // Zoals /stagetwo-tier2:updaten (lib/toepassen.mjs in de plugin).
  const van = manifest.vanDeTemplate;
  for (const pad of van.vervangen) {
    if (existsSync(join(WORTEL, pad))) kopieer(pad, map);
  }
  for (const pad of van.alsHetOntbreekt ?? []) {
    if (!existsSync(join(map, pad)) && existsSync(join(WORTEL, pad))) kopieer(pad, map);
  }
  for (const [pad, welke] of Object.entries(van.sleutelsSamenvoegen ?? {})) {
    if (!existsSync(join(map, pad))) continue;
    const samen = voegSleutelsSamen(
      readFileSync(join(map, pad), "utf8"),
      readFileSync(join(WORTEL, pad), "utf8"),
      welke,
    );
    writeFileSync(join(map, pad), samen);
  }
  for (const [pad, naam] of Object.entries(van.tussenMarkeringen ?? {})) {
    if (!existsSync(join(map, pad))) continue;
    const nieuw = tussenMarkeringen(
      readFileSync(join(map, pad), "utf8"),
      readFileSync(join(WORTEL, pad), "utf8"),
      naam,
    );
    if (nieuw !== null) writeFileSync(join(map, pad), nieuw);
  }
  inApp("add", "-A");
  inApp("commit", "-q", "--allow-empty", "-m", "update naar de huidige stand");

  symlinkSync(join(WORTEL, "node_modules"), join(map, "node_modules"), "dir");
  return map;
}

/** De omgeving van een app op een update-PR: niets van deze testrun of van de template-CI. */
function omgevingVanDeApp(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [sleutel, waarde] of Object.entries(process.env)) {
    if (/^(?:GITHUB_|VITEST|VITE_|TEST$|NODE_ENV$|PR_BODY$)/.test(sleutel)) continue;
    env[sleutel] = waarde;
  }
  // De updater zet deze regel zelf in de PR-tekst.
  env.PR_BODY = "Bevestigd: templatebestanden gewijzigd";
  return env;
}

const STAPPEN: Array<[string, string, string[]]> = [
  ["typecontrole", "node_modules/.bin/tsc", ["--noEmit"]],
  ["lint", "node_modules/.bin/biome", ["check", "."]],
  ["unittests", "node_modules/.bin/vitest", ["run", "--config", "vitest.config.ts"]],
  ["guard:tests", "node", ["scripts/guard-tests.mjs"]],
  ["guard:migrations", "node", ["scripts/guard-migrations.mjs"]],
  ["guard:rls", "node", ["scripts/guard-rls.mjs"]],
  ["guard:rls-tests", "node", ["scripts/guard-rls-tests.mjs"]],
  ["guard:secrets", "node", ["scripts/guard-secrets.mjs"]],
  // Zoals na de build: wat in public/ staat (de iconen van de app), staat dan ook in dist/.
  [
    "guard:secrets met public/ in dist/",
    "sh",
    [
      "-c",
      "rm -rf dist && cp -R public dist && node scripts/guard-secrets.mjs; s=$?; rm -rf dist; exit $s",
    ],
  ],
  ["guard:escapes", "node", ["scripts/guard-escape-hatches.mjs"]],
  ["guard:template", "node", ["scripts/guard-template.mjs"]],
  ["guard:cloudflare", "node", ["scripts/guard-cloudflare.mjs"]],
];

describe("een afgeleide app na de update (alleen in de template zelf)", () => {
  it("herkent de template zoals guard-template dat doet", () => {
    expect(isDeTemplate("https://github.com/Stage-Two-AI/app-template-tier2.git")).toBe(true);
    expect(isDeTemplate("https://github.com/Klant/eigen-app.git")).toBe(false);
    expect(globNaarRegex("beheer/**").test("beheer/lib/x.mjs")).toBe(true);
    expect(globNaarRegex(".github/workflows/proef-*.yml").test(".github/workflows/ci.yml")).toBe(
      false,
    );
  });

  it.runIf(inDeTemplate)(
    "typecontrole, lint, unittests en guards zijn groen in een app van de vorige uitgave",
    () => {
      const manifest: Manifest = JSON.parse(
        readFileSync(join(WORTEL, ".claude/stack-manifest.json"), "utf8"),
      );
      const tag = vorigeTag(manifest.stackVersion);
      if (tag === null || !existsSync(join(WORTEL, "node_modules"))) {
        const reden = "geen git, geen tag stack-vN van een vorige uitgave of geen node_modules";
        // In CI is dit een fout: dan zou deze test ongemerkt niets meer bewijzen.
        if (process.env.CI)
          throw new Error(`De nagebootste app kan niet gebouwd worden: ${reden}.`);
        console.warn(`afgeleide app overgeslagen: ${reden}`);
        return;
      }

      const map = bouwAfgeleideApp(tag, manifest);
      try {
        const env = omgevingVanDeApp();
        const fouten: string[] = [];
        for (const [naam, opdracht, args] of STAPPEN) {
          const uit = spawnSync(opdracht, args, {
            cwd: map,
            env,
            encoding: "utf8",
            maxBuffer: RUIME_BUFFER,
          });
          if (uit.status !== 0) {
            const tekst = `${uit.stdout ?? ""}\n${uit.stderr ?? ""}${uit.error ? `\n${uit.error}` : ""}`;
            fouten.push(`${naam} (op ${tag}):\n${tekst.trim().split("\n").slice(-40).join("\n")}`);
          }
        }
        expect(fouten, "rood in een app na de update").toEqual([]);
      } finally {
        if (!process.env.AFGELEIDE_APP_BEWAREN) rmSync(map, { recursive: true, force: true });
        else console.log(`afgeleide app bewaard in ${map}`);
      }
    },
    300_000,
  );
});
