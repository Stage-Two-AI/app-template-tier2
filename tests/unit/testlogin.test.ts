import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * scripts/testlogin.mjs haalt met `gh` de testlogin uit de beheer-repo en zet die in
 * .env.development.local (alleen de dev-server van Vite leest dat bestand). De tests draaien het script als los proces in een lege map, met een
 * nagebootste `gh` (STAGETWO_GH) die zijn aanroepen opschrijft. Er gaat niets naar GitHub.
 */
const SCRIPTS = resolve(__dirname, "../../scripts");
const TESTLOGIN = join(SCRIPTS, "testlogin.mjs");
const REF = "abcdefghijklmnopqrst";
const URL_TEST = `https://${REF}.supabase.co`;

/** De nagebootste gh: gedrag uit NEP_GH (JSON), aanroepen naar NEP_GH_LOG. */
const NEP_GH = `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const stand = JSON.parse(process.env.NEP_GH);
fs.appendFileSync(process.env.NEP_GH_LOG, JSON.stringify(args) + "\\n");
const [a, b] = args;
if (a === "api" && /^repos\\/[^/]+\\/[^/?]+$/.test(b)) {
  const naam = b.split("/")[2];
  if (stand.repos.includes(naam)) { process.stdout.write(b.slice(6)); process.exit(0); }
  process.stderr.write("gh: Not Found (HTTP 404)\\n"); process.exit(1);
}
if (a === "api" && b.endsWith("/contents/toegang.json")) {
  const naam = b.split("/")[2];
  if (stand.toegang && stand.toegang[naam]) { process.stdout.write(JSON.stringify(stand.toegang[naam])); process.exit(0); }
  process.stderr.write("gh: Not Found (HTTP 404)\\n"); process.exit(1);
}
if (a === "repo" && b === "list") {
  process.stdout.write(JSON.stringify(stand.repos.map((name) => ({ name })))); process.exit(0);
}
if (a === "api" && b.includes("/actions/artifacts")) {
  if (stand.offline) { process.stderr.write("error connecting to api.github.com\\n"); process.exit(1); }
  process.stdout.write(JSON.stringify({ artifacts: stand.artifacts })); process.exit(0);
}
if (a === "run" && b === "download") {
  const dir = args[args.indexOf("--dir") + 1];
  fs.writeFileSync(path.join(dir, "testlogin.json"), JSON.stringify(stand.login));
  process.exit(0);
}
process.stderr.write("nep-gh kent dit niet: " + args.join(" ") + "\\n"); process.exit(1);
`;

const LOGIN = {
  app: "portaal",
  project_ref: REF,
  url: URL_TEST,
  email: "testgebruiker@stagetwo.nl",
  wachtwoord: "NachtWachtwoord1234567890",
  aangemaakt: "2026-10-28T02:41:00Z",
};
const ARTIFACTS = [
  {
    name: "testlogin-portaal",
    expired: false,
    created_at: "2026-10-27T02:41:00Z",
    workflow_run: { id: 1 },
  },
  {
    name: "testlogin-portaal",
    expired: false,
    created_at: "2026-10-28T02:41:00Z",
    workflow_run: { id: 2 },
  },
  {
    name: "testlogin-portaal",
    expired: true,
    created_at: "2026-10-29T02:41:00Z",
    workflow_run: { id: 3 },
  },
];

let map: string;
const ENV_LOCAL = () => join(map, ".env.local");
const ENV_DEV = () => join(map, ".env.development.local");
const devInhoud = () => (existsSync(ENV_DEV()) ? readFileSync(ENV_DEV(), "utf8") : "");

beforeEach(() => {
  map = mkdtempSync(join(tmpdir(), "testlogin-"));
  writeFileSync(
    join(map, "stack.config.json"),
    JSON.stringify({ database: true, testdatabase: { project_ref: REF } }),
  );
  writeFileSync(
    ENV_LOCAL(),
    `VITE_SUPABASE_URL=${URL_TEST}\nVITE_SUPABASE_ANON_KEY=sb_publishable_abc\nVITE_OMGEVING=test\n`,
  );
  execFileSync("git", ["init", "-q"], { cwd: map });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/klant-org/portaal.git"], {
    cwd: map,
  });
  writeFileSync(join(map, "nep-gh.cjs"), NEP_GH);
});

afterEach(() => {
  rmSync(map, { recursive: true, force: true });
});

function draai(
  stand: Record<string, unknown>,
  env: Record<string, string> = {},
  script = TESTLOGIN,
) {
  const log = join(map, "gh.log");
  const schoon = { ...process.env };
  delete schoon.STAGETWO_BEHEER_REPO;
  const r = spawnSync(process.execPath, [script], {
    cwd: map,
    encoding: "utf8",
    env: {
      ...schoon,
      STAGETWO_GH: join(map, "nep-gh.cjs"),
      NEP_GH: JSON.stringify({
        repos: ["stagetwo-beheer-tier2"],
        artifacts: ARTIFACTS,
        login: LOGIN,
        ...stand,
      }),
      NEP_GH_LOG: log,
      ...env,
    },
  });
  const aanroepen = existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((regel) => JSON.parse(regel) as string[])
    : [];
  return { code: r.status, uit: r.stdout + r.stderr, aanroepen };
}

describe("pnpm testlogin", () => {
  it("zet de drie sleutels in .env.development.local, uit het nieuwste geldige artifact", () => {
    const voor = readFileSync(ENV_LOCAL(), "utf8");
    const r = draai({});
    expect(r.code, r.uit).toBe(0);
    // .env.local blijft zoals hij was: dat bestand leest Vite ook bij een build.
    expect(readFileSync(ENV_LOCAL(), "utf8")).toBe(voor);
    const inhoud = devInhoud();
    expect(inhoud).toContain("VITE_TESTLOGIN_EMAIL=testgebruiker@stagetwo.nl\n");
    expect(inhoud).toContain("VITE_TESTLOGIN_WACHTWOORD=NachtWachtwoord1234567890\n");
    expect(inhoud).toContain("VITE_INLOGDIENST=wachtwoord\n");
    // De beheer-repo met de vaste naam, het artifact van de app, de nieuwste run (2).
    expect(r.aanroepen[0]).toEqual([
      "repo",
      "list",
      "klant-org",
      "--limit",
      "1000",
      "--json",
      "name",
    ]);
    expect(r.aanroepen[1]?.[1]).toBe(
      "repos/klant-org/stagetwo-beheer-tier2/actions/artifacts?name=testlogin-portaal&per_page=30",
    );
    expect(r.aanroepen[2]?.slice(0, 7)).toEqual([
      "run",
      "download",
      "2",
      "--repo",
      "klant-org/stagetwo-beheer-tier2",
      "--name",
      "testlogin-portaal",
    ]);
    // Het wachtwoord komt nooit in de uitvoer.
    expect(r.uit).not.toContain(LOGIN.wachtwoord);
    if (process.platform !== "win32") expect(statSync(ENV_DEV()).mode & 0o777).toBe(0o600);
  });

  it("staat in .gitignore", () => {
    const r = spawnSync("git", ["check-ignore", "-q", ".env.development.local"], {
      cwd: resolve("."),
    });
    expect(r.status).toBe(0);
  });

  it("haalt een testlogin van een eerdere versie uit .env.local, de rest blijft staan", () => {
    writeFileSync(
      ENV_LOCAL(),
      [
        `VITE_SUPABASE_URL=${URL_TEST}`,
        "VITE_SUPABASE_ANON_KEY=sb_publishable_abc",
        "# Testlogin (`pnpm testlogin`): de testgebruiker van de testdatabase, elke nacht vernieuwd.",
        "VITE_TESTLOGIN_EMAIL=testgebruiker@stagetwo.nl",
        "VITE_TESTLOGIN_WACHTWOORD=OudWachtwoord1234567890",
        "VITE_INLOGDIENST=wachtwoord",
        "",
      ].join("\n"),
    );
    const r = draai({});
    expect(r.code, r.uit).toBe(0);
    expect(readFileSync(ENV_LOCAL(), "utf8")).toBe(
      `VITE_SUPABASE_URL=${URL_TEST}\nVITE_SUPABASE_ANON_KEY=sb_publishable_abc\nVITE_INLOGDIENST=wachtwoord\n`,
    );
    expect(devInhoud()).toContain("VITE_TESTLOGIN_WACHTWOORD=NachtWachtwoord1234567890\n");
  });

  it("laat andere regels in .env.development.local staan", () => {
    writeFileSync(ENV_DEV(), "EIGEN_INSTELLING=ja\n");
    expect(draai({}).code).toBe(0);
    expect(devInhoud()).toMatch(/^EIGEN_INSTELLING=ja\n/);
    expect(devInhoud()).toContain("VITE_INLOGDIENST=wachtwoord\n");
  });

  it("vervangt bij een volgende run de oude waarden, zonder regels dubbel te zetten", () => {
    expect(draai({}).code).toBe(0);
    const r = draai({ login: { ...LOGIN, wachtwoord: "NieuwWachtwoord0987654321" } });
    expect(r.code, r.uit).toBe(0);
    const inhoud = devInhoud();
    expect(inhoud).toContain("VITE_TESTLOGIN_WACHTWOORD=NieuwWachtwoord0987654321\n");
    expect(inhoud).not.toContain("NachtWachtwoord");
    expect(inhoud.match(/^VITE_TESTLOGIN_EMAIL=/gm)).toHaveLength(1);
    expect(inhoud.match(/^VITE_INLOGDIENST=/gm)).toHaveLength(1);
    expect(inhoud.match(/^# Testlogin/gm)).toHaveLength(1);
  });

  it("zonder stagetwo-beheer-tier2: de enige repo die eindigt op -beheer-tier2", () => {
    const r = draai({ repos: ["portaal", "klant-beheer-tier2", "klant-beheer-tier1"] });
    expect(r.code, r.uit).toBe(0);
    expect(r.aanroepen.some((a) => a[1]?.startsWith("repos/klant-org/klant-beheer-tier2/"))).toBe(
      true,
    );
  });

  it("twee kandidaten: die waarin de app in toegang.json staat", () => {
    const r = draai({
      repos: ["stagetwo-beheer-tier2", "prive-beheer-tier2"],
      toegang: {
        "prive-beheer-tier2": { apps: { portaal: [] } },
        "stagetwo-beheer-tier2": { apps: {} },
      },
    });
    expect(r.code, r.uit).toBe(0);
    expect(
      r.aanroepen.some((a) => a[1]?.startsWith("repos/klant-org/prive-beheer-tier2/actions")),
    ).toBe(true);
  });

  it("twee kandidaten zonder de app: stopt en vraagt om STAGETWO_BEHEER_REPO", () => {
    const r = draai({ repos: ["a-beheer-tier2", "b-beheer-tier2"] });
    expect(r.code).toBe(1);
    expect(r.uit).toContain("STAGETWO_BEHEER_REPO");
    expect(existsSync(ENV_DEV())).toBe(false);
  });

  it("STAGETWO_BEHEER_REPO gaat voor", () => {
    const r = draai({ repos: [] }, { STAGETWO_BEHEER_REPO: "eigen-beheer" });
    expect(r.code, r.uit).toBe(0);
    expect(r.aanroepen[0]?.[1]).toContain("repos/klant-org/eigen-beheer/actions/artifacts");
  });

  it("geen geldig artifact: duidelijke melding, er wordt niets geschreven", () => {
    const voor = readFileSync(ENV_LOCAL(), "utf8");
    const r = draai({ artifacts: [{ ...ARTIFACTS[0], expired: true }] });
    expect(r.code).toBe(1);
    expect(r.uit).toContain("Testdatabase verversen");
    expect(readFileSync(ENV_LOCAL(), "utf8")).toBe(voor);
    expect(existsSync(ENV_DEV())).toBe(false);
  });

  it("offline: een melding en exitcode 1, .env.local blijft staan", () => {
    const voor = readFileSync(ENV_LOCAL(), "utf8");
    const r = draai({ offline: true });
    expect(r.code).toBe(1);
    expect(readFileSync(ENV_LOCAL(), "utf8")).toBe(voor);
  });

  it("een testlogin van een ander project komt er nooit in", () => {
    const r = draai({ login: { ...LOGIN, project_ref: "zzzzzzzzzzzzzzzzzzzz" } });
    expect(r.code).toBe(1);
    expect(r.uit).toContain("zzzzzzzzzzzzzzzzzzzz");
    expect(existsSync(ENV_DEV())).toBe(false);
  });

  it("wijst .env.local niet naar de testdatabase, dan doet het niets, ook geen gh", () => {
    writeFileSync(ENV_LOCAL(), "VITE_SUPABASE_URL=http://127.0.0.1:54321\n");
    const r = draai({});
    expect(r.code).toBe(1);
    expect(r.aanroepen).toEqual([]);
    expect(r.uit).toContain("niet naar de testdatabase");
    expect(existsSync(ENV_DEV())).toBe(false);
  });
});

describe("pnpm env:test", () => {
  it("schrijft .env.local en haalt daarna de testlogin op", () => {
    rmSync(ENV_LOCAL());
    writeFileSync(
      join(map, "stack.config.json"),
      JSON.stringify({
        database: true,
        testdatabase: { project_ref: REF, anon_key: "sb_publishable_abcdefghijkl" },
      }),
    );
    const r = draai({}, {}, join(SCRIPTS, "write-test-env.mjs"));
    expect(r.code, r.uit).toBe(0);
    const inhoud = readFileSync(ENV_LOCAL(), "utf8");
    expect(inhoud).toContain(`VITE_SUPABASE_URL=${URL_TEST}`);
    expect(inhoud).not.toContain("TESTLOGIN");
    expect(devInhoud()).toContain("VITE_TESTLOGIN_EMAIL=testgebruiker@stagetwo.nl");
  });

  it("lukt de testlogin niet, dan een waarschuwing en toch klaar", () => {
    rmSync(ENV_LOCAL());
    writeFileSync(
      join(map, "stack.config.json"),
      JSON.stringify({
        database: true,
        testdatabase: { project_ref: REF, anon_key: "sb_publishable_abcdefghijkl" },
      }),
    );
    const r = draai({ offline: true }, {}, join(SCRIPTS, "write-test-env.mjs"));
    expect(r.code, r.uit).toBe(0);
    expect(r.uit).toContain("pnpm testlogin");
    expect(readFileSync(ENV_LOCAL(), "utf8")).toContain(`VITE_SUPABASE_URL=${URL_TEST}`);
  });
});

describe("de build", () => {
  it("pnpm build laat de testlogin nooit in de gebouwde bestanden, ook niet als hij in de omgeving staat", () => {
    const uit = join(map, "dist");
    const r = spawnSync(
      process.execPath,
      [resolve("scripts/bouwen.mjs"), "--outDir", uit, "--emptyOutDir", "--logLevel", "error"],
      {
        cwd: resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          VITE_TESTLOGIN_EMAIL: "testgebruiker@stagetwo.nl",
          VITE_TESTLOGIN_WACHTWOORD: "MarkeerWachtwoordVoorDeBuild123",
        },
      },
    );
    expect(r.status, r.stderr).toBe(0);
    const assets = join(uit, "assets");
    const js = readdirSync(assets)
      .map((f) => readFileSync(join(assets, f), "utf8"))
      .join("");
    expect(js.length).toBeGreaterThan(1000);
    expect(js).not.toContain("MarkeerWachtwoordVoorDeBuild123");
  }, 120_000);
});
