import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Migraties die gegevens omzetten: de regels `-- verwachting:` (scripts/lib/verwachting.mjs),
 * de eis in guard-migrations.mjs, en de workflows die de droogloop en de kopie in `herstel`
 * draaien. De droogloop zelf heeft een database nodig; die is met de hand nagelopen op een
 * lokale Postgres (zie de uitleg in scripts/droogloop.mjs).
 */
const SCRIPTS = resolve(__dirname, "../../scripts");
const LIB = join(SCRIPTS, "lib/verwachting.mjs");

function roep<T>(functie: string, ...args: unknown[]): T {
  const code = `import(${JSON.stringify(pathToFileURL(LIB).href)}).then((m) => { const a = JSON.parse(process.argv.at(-1)); const zet = (x) => (typeof x === "string" && x.startsWith("datum:") ? new Date(x.slice(6)) : x); process.stdout.write(JSON.stringify(m[a.f](...a.args.map(zet)))); })`;
  return JSON.parse(
    execFileSync(
      "node",
      ["--input-type=module", "-e", code, "--", JSON.stringify({ f: functie, args })],
      { encoding: "utf8" },
    ),
  ) as T;
}

type Regel = { tabel: string; min: number; max: number };

describe("leesVerwachting", () => {
  it("leest tabel en bereik, of één getal", () => {
    const sql = [
      "-- verwachting: public.klanten 120-140",
      "--verwachting: orders 5",
      '-- Verwachting: "Plant" 0 - 3 rijen',
      "update klanten set x = 1;",
    ].join("\n");
    expect(roep<{ regels: Regel[]; fouten: string[] }>("leesVerwachting", sql)).toEqual({
      regels: [
        { tabel: "public.klanten", min: 120, max: 140 },
        { tabel: "public.orders", min: 5, max: 5 },
        { tabel: "public.plant", min: 0, max: 3 },
      ],
      fouten: [],
    });
  });

  it("meldt een regel die niet te lezen is", () => {
    const { fouten } = roep<{ fouten: string[] }>(
      "leesVerwachting",
      "-- verwachting: klanten veel\n-- verwachting: orders 9-2",
    );
    expect(fouten).toHaveLength(2);
  });
});

describe("omgezetteTabellen", () => {
  it("ziet update ... set en delete from, met en zonder schema", () => {
    const sql = `
      update public.klanten k set status = 'oud' where k.id < 10;
      delete from only orders where verlopen;
      update "Plant" set naam = upper(naam);
    `;
    expect(roep<string[]>("omgezetteTabellen", sql).sort()).toEqual([
      "public.klanten",
      "public.orders",
      "public.plant",
    ]);
  });

  it("telt niet mee: commentaar, functies, on delete cascade, policies, triggers, upserts", () => {
    const sql = `
      -- update klanten set x = 1;
      create table a (id int references b (id) on delete cascade on update cascade);
      create policy "p" on a for update to authenticated using (true);
      create trigger t before update on a for each row execute function f();
      grant update, delete on a to authenticated;
      insert into a (id) values (1) on conflict (id) do update set id = excluded.id;
      create function f() returns trigger language plpgsql as $$
      begin update a set id = 2; delete from b; return new; end $$;
      select 'update a set id = 3';
    `;
    expect(roep<string[]>("omgezetteTabellen", sql)).toEqual([]);
  });
});

describe("problemenMetVerwachting", () => {
  it("eist een regel voor elke tabel met een UPDATE of DELETE", () => {
    const sql =
      "-- verwachting: klanten 1-5\nupdate klanten set a = 1;\ndelete from orders where id = 1;";
    expect(roep<string[]>("problemenMetVerwachting", sql)).toEqual([
      'public.orders: een UPDATE of DELETE zonder regel "-- verwachting: public.orders <min>-<max>"',
    ]);
  });

  it("niets te eisen bij een migratie die alleen het schema wijzigt", () => {
    expect(roep<string[]>("problemenMetVerwachting", "alter table a add column b text;")).toEqual(
      [],
    );
  });
});

describe("beoordeel (de uitslag van de droogloop)", () => {
  const regels: Regel[] = [{ tabel: "public.klanten", min: 10, max: 20 }];

  it("groen binnen het bereik", () => {
    expect(roep<string[]>("beoordeel", regels, { "public.klanten": 12 })).toEqual([]);
  });

  it("rood buiten het bereik, en bij een tabel die er niet bij staat", () => {
    expect(
      roep<string[]>("beoordeel", regels, { "public.klanten": 400, "public.orders": 3 }),
    ).toEqual([
      "public.klanten: 400 rijen geraakt, verwacht 10-20",
      "public.orders: 3 rijen geraakt, maar deze tabel staat niet in de verwachting",
    ]);
  });

  it("rood als er niets geraakt wordt terwijl er iets verwacht werd", () => {
    expect(roep<string[]>("beoordeel", regels, {})).toEqual([
      "public.klanten: 0 rijen geraakt, verwacht 10-20",
    ]);
  });
});

describe("kopieën in het schema herstel", () => {
  it("geeft een stempel met datum en tijd in UTC", () => {
    expect(roep<string>("stempel", "datum:2026-11-05T14:32:10Z")).toBe("20261105_1432");
  });

  it("ruimt alleen kopieën met een stempel ouder dan veertien dagen op", () => {
    const nu = "datum:2026-11-20T12:00:00Z";
    expect(roep<boolean>("teOud", "klanten_20261105_1100", nu)).toBe(true);
    expect(roep<boolean>("teOud", "klanten_20261107_1100", nu)).toBe(false);
    expect(roep<boolean>("teOud", "handmatig", nu)).toBe(false);
  });
});

describe("guard-migrations.mjs: de verwachting", () => {
  function inRepo(migratie: string): { code: number; uitvoer: string } {
    const map = mkdtempSync(join(tmpdir(), "verwachting-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: map, stdio: "pipe", encoding: "utf8" });
    try {
      git("init", "-q", "-b", "main");
      git("config", "user.email", "test@voorbeeld.nl");
      git("config", "user.name", "Test");
      writeFileSync(join(map, "stack.config.json"), JSON.stringify({ database: true }));
      git("add", ".");
      git("commit", "-qm", "basis");
      git("checkout", "-qb", "werk");
      mkdirSync(join(map, "supabase/migrations"), { recursive: true });
      writeFileSync(join(map, "supabase/migrations/20261105000000_omzetten.sql"), migratie);
      git("add", ".");
      git("commit", "-qm", "migratie");
      try {
        const uitvoer = execFileSync("node", [join(SCRIPTS, "guard-migrations.mjs")], {
          cwd: map,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, GITHUB_BASE_REF: "", PR_BODY: "" },
        });
        return { code: 0, uitvoer };
      } catch (fout) {
        const e = fout as { status?: number; stdout?: string; stderr?: string };
        return { code: e.status ?? 1, uitvoer: `${e.stdout ?? ""}${e.stderr ?? ""}` };
      }
    } finally {
      rmSync(map, { recursive: true, force: true });
    }
  }

  it("rood bij een UPDATE zonder verwachting", () => {
    const r = inRepo("update public.klanten set status = 'oud' where id < 10;");
    expect(r.code).toBe(1);
    expect(r.uitvoer).toContain("-- verwachting: public.klanten <min>-<max>");
  });

  it("groen met een verwachting", () => {
    const r = inRepo(
      "-- verwachting: public.klanten 5-15\nupdate public.klanten set status = 'oud' where id < 10;",
    );
    expect(r.code).toBe(0);
  });
});

const WORKFLOWS = resolve(__dirname, "../../.github/workflows");
type Stap = {
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = {
  if?: string;
  needs?: string;
  environment?: string;
  permissions?: Record<string, string>;
  steps: Stap[];
};
type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> };
const lees = (naam: string) => parse(readFileSync(join(WORKFLOWS, naam), "utf8")) as Workflow;
const EXPRESSIE = ["$", "{{"].join("");

describe("droogloop-aanvragen.yml en droogloop.yml", () => {
  const aanvraag = lees("droogloop-aanvragen.yml");
  const droog = lees("droogloop.yml");
  const job = droog.jobs.droogloop as Job;
  const bepalen = droog.jobs.bepalen as Job;

  it("de aanvraag draait op elke PR (de status is verplicht), zonder sleutels en zonder code uit de PR", () => {
    expect((aanvraag.on.pull_request as { paths?: string[] }).paths).toBeUndefined();
    const tekst = JSON.stringify(aanvraag);
    expect(tekst).not.toContain("secrets.");
    expect(tekst).not.toContain("environment");
    expect(tekst).not.toContain("actions/checkout");
  });

  it("de overgang: zolang main de droogloop niet heeft, zet de aanvraag zelf de status, alleen voor een PR uit deze repo", () => {
    const stappen = (aanvraag.jobs.aanvragen as Job).steps;
    const overgang = stappen.find((s) => s.name?.startsWith("Overgang"));
    expect(overgang?.if).toBe("github.event.pull_request.head.repo.full_name == github.repository");
    expect(overgang?.run).toContain("contents/.github/workflows/droogloop.yml?ref=$BASIS");
    expect(overgang?.run).toContain('context="Droogloop migraties"');
    expect(overgang?.run).toContain("Niets te oefenen");
  });

  it("eerst bepalen, zonder omgeving: niets te oefenen is meteen groen, een fork die gegevens omzet rood", () => {
    expect(droog.on).toEqual({
      workflow_run: { workflows: ["Droogloop aanvragen"], types: ["completed"] },
    });
    expect(bepalen.environment).toBeUndefined();
    expect(bepalen.permissions).toEqual({ contents: "read", statuses: "write" });
    const status = bepalen.steps.find((s) => s.name === "Status op de PR");
    expect(status?.run).toContain('status success "Niets te oefenen');
    expect(status?.run).toContain('status failure "PR uit een fork');
    expect(status?.env?.EIGEN_REPO).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );
  });

  it("de droogloop draait daarna, vanaf main, in omgeving preview, alleen als er iets te oefenen is", () => {
    expect(job.needs).toBe("bepalen");
    expect(job.if).toBe("needs.bepalen.outputs.oefenen == 'true'");
    expect(job.environment).toBe("preview");
    for (const j of [job, bepalen]) {
      const checkout = j.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
      expect(checkout?.with?.ref).toBe("main");
    }
    expect(job.permissions).toEqual({
      contents: "read",
      "pull-requests": "write",
      statuses: "write",
    });
  });

  it("draait niets uit de PR: geen installatie, de migraties alleen via scripts/droogloop.mjs", () => {
    for (const s of [...bepalen.steps, ...job.steps]) {
      expect(s.run ?? "", s.name).not.toMatch(/pnpm|npm |npx /);
      expect(s.run ?? "", s.name).not.toContain(EXPRESSIE);
    }
    const klaar = job.steps.find((s) => s.name === "Migraties van de PR klaarzetten");
    expect(klaar?.run).toContain("node scripts/droogloop.mjs klaarzetten");
  });

  it("maskeert het wachtwoord van de testdatabase voordat het adres bestaat", () => {
    const stap = job.steps.find((s) => s.run?.includes("droogloop.mjs uitvoeren"));
    const run = stap?.run ?? "";
    expect(run.indexOf("node scripts/db-url.mjs --mask")).toBeGreaterThanOrEqual(0);
    expect(run.indexOf("DROOGLOOP_DB_URL=$(node scripts/db-url.mjs)")).toBeGreaterThan(
      run.indexOf("--mask"),
    );
    expect(stap?.env?.WACHTWOORD).toBe(`${EXPRESSIE} secrets.SUPABASE_TEST_DB_PASSWORD }}`);
  });

  it("ontbreken de sleutels, dan blokkeert dat niet: een bevestigingsregel in de PR-tekst maakt hem groen", () => {
    const check = job.steps.find((s) => s.name === "Is de testdatabase bereikbaar?");
    expect(check?.run).toContain('gh api "repos/$REPO/pulls/$PR" --jq');
    expect(check?.run).toContain("Bevestigd:[[:space:]]*droogloop zonder testdatabase");
    expect(check?.run).toContain("De owner van de beheer-repo lost het op");
    expect(check?.run).not.toContain("Stage Two");
    const uitslag = job.steps.find((s) => s.name === "Uitslag in de PR");
    expect(uitslag?.if).toBe("always()");
    expect(uitslag?.run).toContain(
      'if [ "$DOEN" = "false" ] && [ "$BEVESTIGD" = "true" ]; then staat=success',
    );
  });

  it("zet een status op de commit van de PR en is rood buiten de verwachting", () => {
    const uitslag = job.steps.find((s) => s.name === "Uitslag in de PR");
    expect(uitslag?.run).toContain('context="Droogloop migraties"');
    expect(uitslag?.run).toContain("<!-- droogloop -->");
    const rood = job.steps.at(-1);
    expect(rood?.if).toBe(
      "(steps.check.outputs.doen == 'false' && steps.check.outputs.bevestigd != 'true') || steps.droog.outputs.geslaagd == 'false'",
    );
    expect(rood?.run).toContain("exit 1");
  });
});
