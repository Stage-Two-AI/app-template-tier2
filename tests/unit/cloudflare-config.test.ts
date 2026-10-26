import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * `wrangler.jsonc` is van het project (naam en adres verschillen per app), maar een
 * paar regels moeten in elke app gelijk zijn, anders staat de app ergens open of
 * werken diepe links niet. `scripts/lib/cloudflare-config.mjs` controleert dat; deze
 * test draait die controle zoals CI dat doet: als los Node-proces in een map.
 */
const LIB = resolve(__dirname, "../../scripts/lib/cloudflare-config.mjs");
/** De eigen wrangler.jsonc van deze repo: in de template de tijdelijke stand, in een app vaak de standaardstand. */
const EIGEN = readFileSync(resolve(__dirname, "../../wrangler.jsonc"), "utf8");

/** wrangler.jsonc met commentaar, zoals de template hem levert: de tijdelijke stand. */
const TIJDELIJK_JSONC = `// Hoe deze app op Cloudflare draait.
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "cf-proef",
  "compatibility_date": "2026-09-01",
  // Alleen de gebouwde bestanden; een onbekend pad valt terug op index.html.
  "assets": {
    "directory": "./dist",
    "not_found_handling": "single-page-application"
  },
  "workers_dev": true,
  "preview_urls": true
  // Standaardstand, zodra er een eigen domein is:
  // "routes": [{ "pattern": "<app>.<domein>", "custom_domain": true }]
}
`;

let map: string;

beforeEach(() => {
  map = mkdtempSync(join(tmpdir(), "cf-config-"));
});

afterEach(() => {
  rmSync(map, { recursive: true, force: true });
});

const GOED = {
  name: "cf-proef",
  compatibility_date: "2026-09-01",
  assets: { directory: "./dist", not_found_handling: "single-page-application" },
  workers_dev: true,
  preview_urls: true,
  routes: [{ pattern: "cf-proef.stagetwo.nl", custom_domain: true }],
};

/** De tijdelijke stand: geen eigen domein, alleen het workers.dev-adres achter Access. */
const TIJDELIJK = {
  name: "cf-proef",
  compatibility_date: "2026-09-01",
  assets: { directory: "./dist", not_found_handling: "single-page-application" },
  workers_dev: true,
  preview_urls: true,
};

function schrijf(inhoud: string): void {
  writeFileSync(join(map, "wrangler.jsonc"), inhoud);
}

function controleer(): { code: number | null; uitvoer: string } {
  const code = `import(${JSON.stringify(pathToFileURL(LIB).href)}).then((m) => console.log(JSON.stringify(m.cloudflareConfig())))`;
  const r = spawnSync("node", ["--input-type=module", "-e", code], { cwd: map, encoding: "utf8" });
  return { code: r.status, uitvoer: `${r.stdout}${r.stderr}` };
}

function controleerConfig(config: object): { code: number | null; uitvoer: string } {
  schrijf(JSON.stringify(config));
  return controleer();
}

describe("cloudflareConfig: de twee standen", () => {
  it("geeft naam, stand en hostname terug bij een goede config, ook met commentaar", () => {
    schrijf(`// uitleg\n${JSON.stringify(GOED, null, 2)}`);
    const r = controleer();
    expect(r.code).toBe(0);
    expect(JSON.parse(r.uitvoer)).toEqual({
      worker: "cf-proef",
      stand: "standaard",
      hostname: "cf-proef.stagetwo.nl",
    });
  });

  it("accepteert de tijdelijke stand: workers_dev aan zonder routes", () => {
    const r = controleerConfig(TIJDELIJK);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.uitvoer)).toEqual({
      worker: "cf-proef",
      stand: "tijdelijk",
      hostname: null,
    });
  });

  it("accepteert de tijdelijke stand ook met een lege lijst routes", () => {
    const r = controleerConfig({ ...TIJDELIJK, routes: [] });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.uitvoer).stand).toBe("tijdelijk");
  });

  it("weigert workers_dev uit naast een eigen domein: dan tonen de previews achter Access niets", () => {
    const r = controleerConfig({ ...GOED, workers_dev: false });
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("workers_dev");
    expect(r.uitvoer).toContain("There is nothing here yet");
    expect(r.uitvoer).toContain("standaard");
    expect(r.uitvoer).toContain("tijdelijk");
  });

  it("weigert workers_dev uit zonder routes", () => {
    const r = controleerConfig({ ...TIJDELIJK, workers_dev: false });
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("workers_dev");
  });

  it("weigert een config zonder workers_dev: wrangler zet het dan stilletjes aan", () => {
    const { workers_dev: _weg, ...zonder } = GOED;
    const r = controleerConfig(zonder);
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("workers_dev");
  });

  it("weigert een route zonder custom_domain in de standaardstand", () => {
    const r = controleerConfig({ ...GOED, routes: [{ pattern: "cf-proef.stagetwo.nl/*" }] });
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("custom_domain");
  });

  it("weigert twee eigen domeinen: de standaardstand heeft precies één adres", () => {
    const r = controleerConfig({
      ...GOED,
      routes: [
        { pattern: "cf-proef.stagetwo.nl", custom_domain: true },
        { pattern: "tweede.stagetwo.nl", custom_domain: true },
      ],
    });
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("precies één route");
    expect(r.uitvoer).toContain("standaard");
    expect(r.uitvoer).toContain("tijdelijk");
  });

  it("weigert een eigen domein plus een zone-route: die tweede route staat zonder Access", () => {
    const r = controleerConfig({
      ...GOED,
      routes: [
        { pattern: "cf-proef.stagetwo.nl", custom_domain: true },
        { pattern: "stagetwo.nl/app/*", zone_name: "stagetwo.nl" },
      ],
    });
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("precies één route");
    expect(r.uitvoer).toContain("standaard");
  });

  it("weigert een config zonder single-page-application", () => {
    const r = controleerConfig({ ...GOED, assets: { directory: "./dist" } });
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("single-page-application");
  });

  it("keurt de wrangler.jsonc van deze repo zelf goed, in welke stand die ook staat", () => {
    schrijf(EIGEN);
    const r = controleer();
    expect(r.code, r.uitvoer).toBe(0);
    expect(["tijdelijk", "standaard"]).toContain(JSON.parse(r.uitvoer).stand);
  });

  it("keurt een wrangler.jsonc met commentaar goed in de tijdelijke stand", () => {
    schrijf(TIJDELIJK_JSONC);
    const r = controleer();
    expect(r.code, r.uitvoer).toBe(0);
    expect(JSON.parse(r.uitvoer).stand).toBe("tijdelijk");
  });

  it("keurt een wrangler.jsonc met commentaar goed in de standaardstand", () => {
    // De voorbeeldroute uit het commentaar aanzetten; workers_dev blijft aan.
    const standaard = TIJDELIJK_JSONC.replace(/^(\s*"preview_urls": true)$/m, "$1,").replace(
      /^(\s*)\/\/ ("routes": \[\{ "pattern": )"<app>\.<domein>"/m,
      '$1$2"cf-proef.stagetwo.nl"',
    );
    expect(standaard).toMatch(/^\s*"routes":/m);
    schrijf(standaard);
    const r = controleer();
    expect(r.code, r.uitvoer).toBe(0);
    expect(JSON.parse(r.uitvoer).stand).toBe("standaard");
  });

  it("meldt duidelijk dat het bestand ontbreekt", () => {
    const r = controleer();
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("wrangler.jsonc");
  });

  it("meldt duidelijk dat het bestand geen geldige JSON is", () => {
    schrijf("{ name: ");
    const r = controleer();
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("wrangler.jsonc");
    expect(r.uitvoer).toContain("JSON");
  });
});

describe("cloudflareConfig: alleen toegestane sleutels (geen opslag van Cloudflare)", () => {
  for (const sleutel of ["d1_databases", "r2_buckets", "kv_namespaces"]) {
    it(`weigert ${sleutel} op het hoogste niveau`, () => {
      const r = controleerConfig({ ...GOED, [sleutel]: [{ binding: "X", id: "y" }] });
      expect(r.code).not.toBe(0);
      expect(r.uitvoer).toContain(sleutel);
      expect(r.uitvoer).toContain("gegevens staan in Supabase");
    });

    it(`weigert ${sleutel} binnen env.production`, () => {
      const r = controleerConfig({
        ...GOED,
        env: { production: { [sleutel]: [{ binding: "X", id: "y" }] } },
      });
      expect(r.code).not.toBe(0);
      expect(r.uitvoer).toContain(`env.production.${sleutel}`);
      expect(r.uitvoer).toContain("gegevens staan in Supabase");
    });
  }

  it("weigert durable_objects op het hoogste niveau en binnen env.*", () => {
    const binding = { bindings: [{ name: "X", class_name: "Y" }] };
    const boven = controleerConfig({ ...GOED, durable_objects: binding });
    expect(boven.code).not.toBe(0);
    expect(boven.uitvoer).toContain("durable_objects");
    const inEnv = controleerConfig({ ...GOED, env: { preview: { durable_objects: binding } } });
    expect(inEnv.code).not.toBe(0);
    expect(inEnv.uitvoer).toContain("env.preview.durable_objects");
  });

  it("weigert main op het hoogste niveau en binnen env.*", () => {
    const boven = controleerConfig({ ...GOED, main: "src/worker.ts" });
    expect(boven.code).not.toBe(0);
    expect(boven.uitvoer).toContain("main");
    expect(boven.uitvoer).toContain("Worker-code");
    const inEnv = controleerConfig({ ...GOED, env: { production: { main: "src/worker.ts" } } });
    expect(inEnv.code).not.toBe(0);
    expect(inEnv.uitvoer).toContain("env.production.main");
  });

  it("weigert een onbekende nieuwe sleutel, met een nette melding", () => {
    const r = controleerConfig({
      ...GOED,
      containers: [{ class_name: "X", image: "./Dockerfile" }],
    });
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("`containers`");
    expect(r.uitvoer).toContain("staat niet op de lijst");
  });

  it("weigert een onbekende sleutel binnen env.*", () => {
    const r = controleerConfig({ ...GOED, env: { production: { queues: {} } } });
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("env.production.queues");
  });

  it("noemt alle verboden sleutels in één keer", () => {
    const r = controleerConfig({
      ...GOED,
      kv_namespaces: [],
      containers: [],
      env: { production: { r2_buckets: [] } },
    });
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("kv_namespaces");
    expect(r.uitvoer).toContain("containers");
    expect(r.uitvoer).toContain("env.production.r2_buckets");
  });

  it("weigert routes binnen env.production: een omgeving mag geen tweede adres openen", () => {
    const r = controleerConfig({
      ...GOED,
      env: { production: { routes: [{ pattern: "ander.stagetwo.nl", custom_domain: true }] } },
    });
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("env.production.routes");
  });

  it("weigert workers_dev: true binnen env.*", () => {
    const r = controleerConfig({ ...GOED, env: { preview: { workers_dev: true } } });
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("env.preview.workers_dev");
  });

  it("weigert een env die geen object is", () => {
    const r = controleerConfig({ ...GOED, env: { production: "ja" } });
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("env.production");
  });

  it("laat de bekende onschuldige sleutels door, ook binnen env.*", () => {
    const r = controleerConfig({
      $schema: "node_modules/wrangler/config-schema.json",
      ...GOED,
      compatibility_flags: ["nodejs_compat"],
      observability: { enabled: true },
      vars: { OMGEVING: "productie" },
      keep_vars: false,
      env: {
        production: {
          compatibility_flags: ["nodejs_compat"],
          observability: { enabled: true },
          vars: { OMGEVING: "productie" },
        },
      },
    });
    expect(r.code, r.uitvoer).toBe(0);
  });
});
