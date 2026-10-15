import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * guard:cloudflare draait de controle van `scripts/lib/cloudflare-config.mjs` op het
 * echte `wrangler.jsonc`, als eigen stap in de verplichte check "Code". Zo kan een PR
 * die om opslag van Cloudflare vraagt (D1, R2, KV, Durable Objects) niet mergen.
 */
const ROOT = resolve(__dirname, "../..");
const GUARD = resolve(ROOT, "scripts/guard-cloudflare.mjs");

let map: string;

beforeEach(() => {
  map = mkdtempSync(join(tmpdir(), "guard-cloudflare-"));
});

afterEach(() => {
  rmSync(map, { recursive: true, force: true });
});

function draai(): { code: number | null; uitvoer: string } {
  const r = spawnSync("node", [GUARD], { cwd: map, encoding: "utf8" });
  return { code: r.status, uitvoer: `${r.stdout}${r.stderr}` };
}

describe("guard:cloudflare", () => {
  it("slaagt op de wrangler.jsonc van deze repo", () => {
    writeFileSync(join(map, "wrangler.jsonc"), readFileSync(join(ROOT, "wrangler.jsonc"), "utf8"));
    const r = draai();
    expect(r.code, r.uitvoer).toBe(0);
  });

  it("faalt met een KV-binding", () => {
    const config = {
      name: "app",
      assets: { directory: "./dist", not_found_handling: "single-page-application" },
      workers_dev: true,
      routes: [{ pattern: "app.klant.nl", custom_domain: true }],
      kv_namespaces: [{ binding: "X", id: "y" }],
    };
    writeFileSync(join(map, "wrangler.jsonc"), JSON.stringify(config));
    const r = draai();
    expect(r.code).toBe(1);
    expect(r.uitvoer).toContain("kv_namespaces");
    expect(r.uitvoer).toContain("gegevens staan in Supabase");
  });

  it("faalt als wrangler.jsonc ontbreekt", () => {
    const r = draai();
    expect(r.code).toBe(1);
    expect(r.uitvoer).toContain("wrangler.jsonc");
  });

  it("faalt als wrangler.jsonc niet te lezen is", () => {
    // Een map met die naam: bestaat wel, maar is niet als bestand te lezen.
    mkdirSync(join(map, "wrangler.jsonc"));
    const r = draai();
    expect(r.code).toBe(1);
    expect(r.uitvoer).toContain("wrangler.jsonc");
  });

  it("faalt als wrangler.jsonc geen geldige JSON is", () => {
    writeFileSync(join(map, "wrangler.jsonc"), "{ kapot");
    const r = draai();
    expect(r.code).toBe(1);
    expect(r.uitvoer).toContain("wrangler.jsonc");
  });

  it("zit in pnpm guard en draait als stap in de verplichte check Code", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["guard:cloudflare"]).toBe("node scripts/guard-cloudflare.mjs");
    expect(pkg.scripts.guard).toContain("pnpm guard:cloudflare");
    const ci = parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8")) as {
      jobs: Record<string, { name?: string; steps: { run?: string; if?: string }[] }>;
    };
    const stap = ci.jobs.checks?.steps.find((s) => s.run === "pnpm guard:cloudflare");
    expect(ci.jobs.checks?.name).toBe("Code");
    expect(stap).toBeDefined();
    expect(stap?.if).toBeUndefined();
  });

  it("staat in het manifest als bestand van de template", () => {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, ".claude/stack-manifest.json"), "utf8"),
    ) as {
      vanDeTemplate: { vervangen: string[] };
    };
    expect(manifest.vanDeTemplate.vervangen).toContain("scripts/guard-cloudflare.mjs");
  });
});
