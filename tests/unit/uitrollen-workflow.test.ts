import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * De uitrol-workflow bepaalt wie welke sleutel te zien krijgt. Een pull request mag
 * nooit bij de sleutels van productie of van de inrichting: GitHub geeft secrets van
 * een omgeving aan elke job die die omgeving noemt, ook op een PR-tak.
 */
const WORKFLOWS = resolve(__dirname, "../../.github/workflows");

type Stap = {
  name?: string;
  shell?: string;
  id?: string;
  run?: string;
  uses?: string;
  if?: string;
  with?: Record<string, string | number | boolean>;
  env?: Record<string, string>;
};
type Job = {
  if?: string;
  environment?: string | { name: string };
  permissions?: Record<string, string>;
  steps: Stap[];
};
type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> };

function lees(naam: string): Workflow {
  return parse(readFileSync(join(WORKFLOWS, naam), "utf8")) as Workflow;
}

function omgeving(job: Job): string | undefined {
  return typeof job.environment === "string" ? job.environment : job.environment?.name;
}

const uitrollen = lees("uitrollen.yml");
const previewUitrollen = lees("preview-uitrollen.yml");

function job(naam: string, wf: Workflow = uitrollen): Job {
  const gevonden = wf.jobs[naam];
  if (!gevonden) throw new Error(`job ${naam} ontbreekt`);
  return gevonden;
}

function stapIndex(j: Job, zoek: (s: Stap) => boolean): number {
  const i = j.steps.findIndex(zoek);
  if (i < 0) throw new Error("stap ontbreekt");
  return i;
}

/** Het begin van een GitHub-expressie, zoals hij in de YAML staat. */
const EXPRESSIE = ["$", "{{"].join("");

/** Een volledige GitHub-expressie, bijvoorbeeld voor `vars.X`. */
function gh(inhoud: string): string {
  return `${EXPRESSIE} ${inhoud} }}`;
}

describe("uitrollen.yml", () => {
  it("rolt productie alleen uit bij een push op main, in omgeving production", () => {
    const productie = job("productie");
    expect(productie.if).toContain("github.event_name == 'push'");
    expect(omgeving(productie)).toBe("production");
    expect(uitrollen.on.push).toEqual({ branches: ["main"] });
  });

  it("rolt productie niet uit zolang de database nog niet is ingericht", () => {
    const controle = job("productie").steps.find((s) => s.run?.includes("VITE_SUPABASE_URL"));
    expect(controle?.run).toContain("skip=true");
    const deploy = job("productie").steps.find((s) => s.run?.includes("wrangler deploy"));
    expect(deploy?.if).toContain("skip != 'true'");
  });

  it("waarschuwt bij elke productie-uitrol als Sentry uit staat of de DSN vreemd is", () => {
    const controle = job("productie").steps.find((s) => s.name === "Is alles ingericht?");
    expect(controle?.env?.VITE_SENTRY_DSN).toBe(gh("vars.VITE_SENTRY_DSN"));
    expect(controle?.shell).toBe("bash");
    const run = controle?.run ?? "";
    expect(run).toContain('if [ -z "$VITE_SENTRY_DSN" ]; then');
    expect(run).toContain("::warning::Foutbewaking (Sentry) staat uit");
    expect(run).toContain("::warning::VITE_SENTRY_DSN ziet er niet uit als een DSN van Sentry");
    // Een waarschuwing, geen stop: de regels over Sentry zetten geen skip.
    const sentryDeel = run.slice(run.indexOf("VITE_SENTRY_DSN"));
    expect(sentryDeel.split("fi")[0]).not.toContain("skip=true");
  });

  it("herkent een echte DSN van Sentry, en geen vreemde waarde", () => {
    const run = job("productie").steps.find((s) => s.name === "Is alles ingericht?")?.run ?? "";
    const patroon = /=~ \^(.+)\$ \]\]/.exec(run)?.[1];
    expect(patroon).toBeDefined();
    const dsn = new RegExp(`^${patroon}$`);
    expect(dsn.test("https://abc123@o1.ingest.sentry.io/42")).toBe(true);
    expect(dsn.test("https://abc123@o4507.ingest.de.sentry.io/4508")).toBe(true);
    expect(dsn.test("https://sentry.io/abc")).toBe(false);
    expect(dsn.test("abc123")).toBe(false);
  });

  it("slaat productie over met een melding als de uitrolsleutel ontbreekt", () => {
    const controle = job("productie").steps.find((s) => s.run?.includes("CLOUDFLARE_API_TOKEN"));
    expect(controle?.run).toContain("::notice::");
  });
});

describe("uitrollen.yml: productie, plus de overgang voor de eerste update-PR", () => {
  const overgang = job("overgang");

  it("draait bij een push op main, en op een PR alleen als die preview-uitrollen.yml wijzigt", () => {
    expect(uitrollen.on).toEqual({
      push: { branches: ["main"] },
      pull_request: { paths: [".github/workflows/preview-uitrollen.yml"] },
    });
    expect(Object.keys(uitrollen.jobs).sort()).toEqual(["overgang", "productie"]);
    expect(job("productie").if).toContain("github.event_name == 'push'");
  });

  it("de overgang draait alleen op een PR uit deze repo, zonder omgeving en zonder secrets", () => {
    expect(overgang.if).toContain("github.event_name == 'pull_request'");
    expect(overgang.if).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(omgeving(overgang)).toBeUndefined();
    expect(JSON.stringify(overgang)).not.toContain("secrets.");
    expect(overgang.permissions).toEqual({ contents: "read" });
  });

  it("bouwt alleen als main nog de oude Preview uitrollen heeft (die op Uitrollen wacht)", () => {
    const eerste = overgang.steps[0];
    expect(eerste?.id).toBe("oud");
    expect(eerste?.run).toContain("?ref=main");
    for (const stap of overgang.steps.slice(1)) {
      expect(stap.if ?? "", stap.name ?? stap.uses ?? stap.run).toMatch(
        /steps\.(oud|preview)\.outputs\./,
      );
    }
    // Dezelfde zoekregel als in de stap: raak bij de oude versie, mis bij de nieuwe van deze template.
    const patroon = /'(\^ \+workflows: \\\[Uitrollen\\\])'/.exec(eerste?.run ?? "")?.[1];
    expect(patroon).toBeDefined();
    const regel = new RegExp(patroon ?? "", "m");
    expect(regel.test("on:\n  workflow_run:\n    workflows: [Uitrollen]\n")).toBe(true);
    expect(regel.test(readFileSync(join(WORKFLOWS, "preview-uitrollen.yml"), "utf8"))).toBe(false);
  });

  it("bewaart preview-dist, het artifact waar de oude Preview uitrollen op main naar zoekt", () => {
    const bewaren = overgang.steps.at(-1);
    expect(bewaren?.uses).toMatch(/^actions\/upload-artifact@/);
    expect(bewaren?.with?.name).toBe("preview-dist");
    const bouwen = overgang.steps.find((s) => s.run === "pnpm build");
    expect(bouwen?.env?.VITE_OMGEVING).toBe("test");
  });
});

describe("ci.yml: de job Code bouwt ook de preview, zonder sleutels", () => {
  const ci = lees("ci.yml");
  const code = job("checks", ci);
  const tekst = JSON.stringify(code);

  it("noemt geen omgeving en leest geen enkel secret", () => {
    expect(code.environment).toBeUndefined();
    expect(tekst).not.toContain("secrets.");
    expect(tekst).not.toContain("CLOUDFLARE_API_TOKEN");
    // wrangler komt alleen voor in de droogoefening, nooit met een echte uitrol.
    const metWrangler = code.steps.filter((s) => JSON.stringify(s).includes("wrangler"));
    expect(metWrangler.map((s) => s.run)).toEqual([
      'pnpm exec wrangler deploy --dry-run --outdir "$RUNNER_TEMP/wrangler-dry"',
    ]);
    expect(tekst).not.toContain("versions upload");
  });

  it("bouwt één keer, met de PREVIEW_-repovariabelen omgezet naar de VITE_-namen, en met de testbalk", () => {
    const bouwen = code.steps.filter((s) => s.run?.includes("pnpm build"));
    expect(bouwen).toHaveLength(1);
    expect(bouwen[0]?.env).toMatchObject({
      VITE_SUPABASE_URL: gh("vars.PREVIEW_VITE_SUPABASE_URL"),
      VITE_SUPABASE_ANON_KEY: gh("vars.PREVIEW_VITE_SUPABASE_ANON_KEY"),
      VITE_INLOGDIENST: gh("vars.PREVIEW_VITE_INLOGDIENST"),
      VITE_SENTRY_DSN: gh("vars.PREVIEW_VITE_SENTRY_DSN"),
      VITE_OMGEVING: "test",
    });
    for (const waarde of Object.values(bouwen[0]?.env ?? {})) {
      if (waarde.startsWith(EXPRESSIE)) expect(waarde).toContain("vars.PREVIEW_");
    }
  });

  it("haalt de wrangler-config van de PR na het bouwen door wrangler, droog en zonder sleutel", () => {
    const bouw = stapIndex(code, (s) => s.run?.includes("pnpm build") ?? false);
    const droog = stapIndex(code, (s) => s.run?.includes("wrangler deploy --dry-run") ?? false);
    expect(droog).toBeGreaterThan(bouw);
    const stap = code.steps[droog];
    expect(stap?.env).toEqual({ WRANGLER_SEND_METRICS: "false" });
    expect(stap?.if).toBe("steps.preview.outputs.skip != 'true'");
  });

  it("controleert de bundel met testwaarden op geheimen vóór het bewaren", () => {
    const bouw = stapIndex(code, (s) => s.run?.includes("pnpm build") ?? false);
    const geheimen = stapIndex(code, (s) => s.run === "pnpm guard:secrets");
    const bewaar = stapIndex(code, (s) => s.uses?.startsWith("actions/upload-artifact@") ?? false);
    expect(geheimen).toBeGreaterThan(bouw);
    expect(bewaar).toBeGreaterThan(geheimen);
  });

  it("bewaart dist als laatste stap, dus alleen als alle controles groen zijn", () => {
    const bewaar = code.steps.at(-1);
    expect(bewaar?.uses).toMatch(/^actions\/upload-artifact@/);
    expect(bewaar?.with?.name).toBe("preview-dist");
    expect(bewaar?.with?.path).toBe("dist");
    expect(bewaar?.if).toBe("steps.preview.outputs.skip != 'true'");
  });

  it("slaat de preview over met een melding bij een fork of zonder testwaarden", () => {
    const controle = code.steps.find((s) => s.id === "preview");
    expect(controle?.env?.EIGEN_REPO).toBe(
      gh("github.event.pull_request.head.repo.full_name == github.repository"),
    );
    expect(controle?.run).toContain("PREVIEW_VITE_SUPABASE_URL");
    expect(controle?.run).toContain("::notice::");
    expect(controle?.run).toContain("skip=true");
  });
});

describe("preview-uitrollen.yml: de upload vanaf main", () => {
  const upload = job("preview", previewUitrollen);
  const stappen = upload.steps;

  it("draait na de Kwaliteitspoort, nooit direct op een pull request", () => {
    expect(previewUitrollen.on).toEqual({
      workflow_run: { workflows: ["Kwaliteitspoort"], types: ["completed"] },
    });
  });

  it("draait voor een PR-run uit dezelfde repo, ook als alleen de browsertest rood is", () => {
    expect(upload.if).toContain("github.event.workflow_run.event == 'pull_request'");
    // Het artifact beslist (de job Code bewaart het alleen als hij groen is), niet de uitkomst
    // van de hele run; alleen een afgebroken run slaat over.
    expect(upload.if).toContain("github.event.workflow_run.conclusion != 'cancelled'");
    expect(upload.if).not.toContain("conclusion == 'success'");
    expect(upload.if).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );
  });

  it("gebruikt omgeving preview, met alleen de rechten die hij nodig heeft", () => {
    expect(omgeving(upload)).toBe("preview");
    expect(upload.permissions).toEqual({
      contents: "read",
      actions: "read",
      "pull-requests": "write",
    });
  });

  it("checkt main uit, niet de code van de PR", () => {
    const checkout = stappen.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.ref).toBe("main");
    expect(JSON.stringify(upload)).not.toContain("head_sha");
    expect(JSON.stringify(upload)).not.toContain("head_branch");
  });

  it("haalt het PR-nummer uit de gebeurtenis via env, en slaat netjes over zonder PR", () => {
    const nummer = stappen.find((s) => s.env?.PR);
    expect(nummer?.env?.PR).toBe(gh("github.event.workflow_run.pull_requests[0].number"));
    expect(nummer?.run).toContain("::notice::");
    expect(nummer?.run).toContain("skip=true");
  });

  it("zet nergens een GitHub-expressie in een run-regel", () => {
    for (const s of stappen) {
      expect(s.run ?? "", s.name).not.toContain(EXPRESSIE);
    }
  });

  it("slaat over met een melding als de uitrolsleutel ontbreekt", () => {
    const controle = stappen.find((s) => s.env?.CLOUDFLARE_API_TOKEN && s.run?.includes("-z"));
    expect(controle?.run).toContain("::notice::");
    expect(controle?.run).toContain("skip=true");
  });

  it("pakt het artifact van precies die run uit, alleen naar dist, na de installatie", () => {
    const i = stapIndex(upload, (s) => s.uses?.startsWith("actions/download-artifact@") ?? false);
    const ophalen = stappen[i];
    expect(ophalen?.with).toMatchObject({
      name: "preview-dist",
      path: "dist",
      "run-id": gh("github.event.workflow_run.id"),
    });
    const installeren = stapIndex(upload, (s) => s.run?.includes("pnpm install") ?? false);
    expect(installeren).toBeLessThan(i);
    // Na het ophalen draait er niets uit dist: alleen de upload en de PR-reactie.
    for (const s of stappen.slice(i + 1)) {
      expect(s.uses).toBeUndefined();
      expect(s.run ?? "").not.toMatch(
        /(^|[\s;|&(])(\.\/|dist\/|node |sh |bash |pnpm (install|build|run))/m,
      );
    }
  });

  it("uploadt een versie met een vaste alias per PR, zonder productie aan te raken", () => {
    const stap = stappen.find((s) => s.run?.includes("versions upload"));
    expect(stap?.run).toContain('--preview-alias "pr-$PR"');
    expect(JSON.stringify(upload)).not.toContain("wrangler deploy");
    expect(stap?.env?.CLOUDFLARE_API_TOKEN).toBe(gh("secrets.CLOUDFLARE_API_TOKEN"));
  });

  it("zet dezelfde code ook op het vaste adres van de app (actueel-...)", () => {
    const stap = stappen.find((s) => s.run?.includes("versions upload"));
    const run = stap?.run ?? "";
    expect(run).toContain("--preview-alias actueel");
    expect(run.match(/wrangler versions upload/g)).toHaveLength(2);
    expect(run).toContain('echo "vast=');
    const reactie = stappen.find((s) => s.run?.includes("<!-- cloudflare-preview -->"));
    expect(reactie?.env?.VAST).toBe(gh("steps.upload.outputs.vast"));
    expect(reactie?.run).toContain("Vast adres van deze app");
  });

  it("laat een mislukte upload de stap laten falen, ondanks de pipe naar tee", () => {
    const stap = stappen.find((s) => s.run?.includes("versions upload"));
    expect(stap?.shell).toBe("bash");
    const run = stap?.run ?? "";
    expect(run).toMatch(/^set -o pipefail$/m);
    expect(run.indexOf("set -o pipefail")).toBeLessThan(run.indexOf("versions upload"));
  });

  it("waarschuwt als er na een geslaagde upload geen previewlink gevonden is", () => {
    const run = stappen.find((s) => s.run?.includes("versions upload"))?.run ?? "";
    expect(run).toMatch(/if \[ -z "\$url" \]/);
    expect(run).toContain("::warning::");
  });

  it("meldt in de PR-reactie dat de preview de wrangler-config van main gebruikt", () => {
    const reactie = stappen.find((s) => s.run?.includes("<!-- cloudflare-preview -->"));
    expect(reactie?.run).toContain("wrangler.jsonc van main");
  });

  it("zet de previewlink als één reactie in de PR en werkt die bij (AE3)", () => {
    const reactie = stappen.find((s) => s.run?.includes("<!-- cloudflare-preview -->"));
    expect(reactie?.run).toContain("-X PATCH");
    expect(reactie?.run).toContain("-X POST");
    expect(reactie?.env?.PR).toBe(gh("steps.pr.outputs.nummer"));
  });
});

describe("sleutels per omgeving, in alle workflows", () => {
  const bestanden = readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml"));

  it("geen job die op een pull request kan draaien noemt proef-beheer of production", () => {
    for (const naam of bestanden) {
      const wf = lees(naam);
      const opPr = "pull_request" in (wf.on ?? {}) || "pull_request_target" in (wf.on ?? {});
      if (!opPr) continue;
      for (const [jobNaam, job] of Object.entries(wf.jobs)) {
        const env = omgeving(job);
        if (env === "proef-beheer" || env === "production") {
          expect(job.if ?? "", `${naam}/${jobNaam}`).toContain("github.event_name == 'push'");
        }
      }
    }
  });

  it("een job na een andere run (workflow_run) noemt hooguit omgeving preview", () => {
    for (const naam of bestanden) {
      const wf = lees(naam);
      if (!("workflow_run" in (wf.on ?? {}))) continue;
      for (const [jobNaam, job] of Object.entries(wf.jobs)) {
        const env = omgeving(job);
        if (env !== undefined) expect(env, `${naam}/${jobNaam}`).toBe("preview");
      }
    }
  });
});

describe("kwaliteitspoort", () => {
  const ci = lees("ci.yml");
  const typen = (ci.on.pull_request as { types: string[] }).types;

  it("draait opnieuw als een concept-PR op klaar wordt gezet", () => {
    expect(typen).toEqual(["opened", "synchronize", "reopened", "ready_for_review"]);
  });

  it("draait de snelle job altijd, de zware pas als Code groen is", () => {
    expect(job("checks", ci).if).toBeUndefined();
    expect((job("database", ci) as Job & { needs?: string }).needs).toBe("checks");
    expect(job("database", ci).if).toBe("needs.checks.outputs.stand != 'niets'");
  });

  it("bepaalt in Code wat de databasejob doet: alles, alleen de database bij een concept met supabase/, of niets", () => {
    const code = job("checks", ci) as Job & { outputs?: Record<string, string> };
    expect(code.outputs?.stand).toBe(gh("steps.wat.outputs.stand"));
    const wat = code.steps.find((s) => s.id === "wat");
    expect(wat?.env).toEqual({
      CONCEPT: gh("github.event.pull_request.draft"),
      BASIS: gh("github.event.pull_request.base.sha"),
    });
    const run = wat?.run ?? "";
    expect(run).toContain('if [ "$CONCEPT" != "true" ]; then');
    expect(run).toContain('git diff --name-only "$BASIS"...HEAD -- supabase/');
    for (const stand of ["alles", "database", "niets"]) expect(run).toContain(`stand=${stand}`);
  });

  it("draait bij een concept geen browser: de browserstappen alleen bij stand alles", () => {
    const db = job("database", ci);
    const browser = db.steps.filter(
      (s) =>
        !s.run?.startsWith("echo") &&
        /playwright|Browser|browser/.test(`${s.name ?? ""} ${s.run ?? ""} ${s.uses ?? ""}`),
    );
    expect(browser.length).toBeGreaterThanOrEqual(4);
    for (const s of browser.filter((s) => s.if)) {
      if (s.if?.includes("failure()")) continue;
      expect(s.if, s.name).toContain("needs.checks.outputs.stand == 'alles'");
    }
    const e2e = db.steps.find((s) => s.run === "pnpm test:e2e");
    expect(e2e?.if).toContain("needs.checks.outputs.stand == 'alles'");
    const rls = db.steps.find((s) => s.run === "pnpm test:rls");
    expect(rls?.if).not.toContain("stand");
  });

  it("controleert de edge functions met deno check", () => {
    const code = job("checks", ci);
    const deno = code.steps.find((s) => s.run?.includes("deno check"));
    expect(deno?.if).toBe("hashFiles('supabase/functions/**/*.ts') != ''");
    expect(code.steps.some((s) => s.uses?.startsWith("denoland/setup-deno@"))).toBe(true);
  });

  it("draait in de job Code de RLS-guards: beveiliging per tabel en de A/B-test per tabel", () => {
    const runs = job("checks", ci).steps.map((s) => s.run);
    expect(runs).toContain("pnpm guard:rls");
    expect(runs).toContain("pnpm guard:rls-tests");
  });

  it("bewaart de browser van Playwright tussen runs", () => {
    const cache = job("database", ci).steps.find((s) => s.uses?.startsWith("actions/cache"));
    expect(cache?.with?.path).toBe("~/.cache/ms-playwright");
    expect(String(cache?.with?.key)).toContain("steps.playwright.outputs.versie");
  });
});
