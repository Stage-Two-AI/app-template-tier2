import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * guard:template slaat de controle over in de templates zelf: daar is een wijziging
 * aan templatebestanden juist de bedoeling. De Cloudflare-variant is ook een template.
 * In een afgeleide app loopt de controle gewoon door.
 */
const GUARD = resolve(__dirname, "../../scripts/guard-template.mjs");

function draai(repository: string): string {
  const uitkomst = spawnSync("node", [GUARD], {
    cwd: resolve(__dirname, "../.."),
    encoding: "utf8",
    env: { ...process.env, GITHUB_REPOSITORY: repository, PR_BODY: "" },
  });
  return `${uitkomst.stdout}${uitkomst.stderr}`;
}

describe("guard:template herkent de templates", () => {
  it("slaat over in stack-template", () => {
    expect(draai("Stage-Two-AI/stack-template")).toContain("dit is de template zelf");
  });

  it("slaat over in app-template-tier2 en app-template-tier1", () => {
    expect(draai("Stage-Two-AI/app-template-tier2")).toContain("dit is de template zelf");
    expect(draai("Stage-Two-AI/app-template-tier1")).toContain("dit is de template zelf");
  });

  it("slaat over onder de oude naam (doorverwijzing van GitHub)", () => {
    expect(draai("Stage-Two-AI/stack-template-cloudflare")).toContain("dit is de template zelf");
  });

  it("slaat niet over in een afgeleide app", () => {
    expect(draai("Klant-BV/planning")).not.toContain("dit is de template zelf");
  });

  it("slaat niet over bij een naam die er alleen op lijkt", () => {
    expect(draai("Klant-BV/stack-template-cloudflare-kopie")).not.toContain(
      "dit is de template zelf",
    );
  });
});

/**
 * Een beveiligingsupdate van Dependabot kan de versie van een GitHub Action in een workflow
 * ophogen. Zo'n pull request van dependabot[bot] die alleen `uses:`-regels wijzigt, mag door;
 * al het andere blijft de bevestigingsregel nodig hebben. Getest in een losse git-repo met
 * dezelfde guard en hetzelfde manifest.
 */
describe("guard:template en Dependabot", () => {
  const WORTEL = resolve(__dirname, "../..");
  const WORKFLOW = [
    "name: CI",
    "on: pull_request",
    "jobs:",
    "  code:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v5",
    "      - uses: actions/setup-node@v5 # v5.0.0",
    "        with:",
    "          node-version: 22",
    "",
  ].join("\n");

  function metRepo(wijzig: (tekst: string) => string, actor: string): string {
    const map = mkdtempSync(join(tmpdir(), "guard-template-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", map, ...args], { encoding: "utf8", stdio: "pipe" });
      git("init", "-q", "-b", "main");
      git("config", "user.name", "Test");
      git("config", "user.email", "test@example.com");
      for (const pad of [
        "scripts/guard-template.mjs",
        "scripts/lib/changed-files.mjs",
        ".claude/stack-manifest.json",
      ]) {
        mkdirSync(dirname(join(map, pad)), { recursive: true });
        copyFileSync(join(WORTEL, pad), join(map, pad));
      }
      mkdirSync(join(map, ".github/workflows"), { recursive: true });
      writeFileSync(join(map, ".github/workflows/ci.yml"), WORKFLOW);
      git("add", "-A");
      git("commit", "-q", "-m", "basis");
      git("checkout", "-q", "-b", "dependabot/github_actions/x");
      writeFileSync(join(map, ".github/workflows/ci.yml"), wijzig(WORKFLOW));
      git("commit", "-q", "-am", "wijziging");
      const uitkomst = spawnSync("node", ["scripts/guard-template.mjs"], {
        cwd: map,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_REPOSITORY: "Klant-BV/planning",
          GITHUB_BASE_REF: "",
          GITHUB_ACTOR: actor,
          PR_BODY: "",
        },
      });
      return `${uitkomst.status}|${uitkomst.stdout}${uitkomst.stderr}`;
    } finally {
      rmSync(map, { recursive: true, force: true });
    }
  }

  const nieuweVersie = (tekst: string) =>
    tekst
      .replace("actions/checkout@v5", "actions/checkout@v6")
      .replace("actions/setup-node@v5 # v5.0.0", "actions/setup-node@v5.1.2 # v5.1.2");

  it("laat een voorstel van dependabot[bot] door dat alleen uses:-regels wijzigt", () => {
    const uit = metRepo(nieuweVersie, "dependabot[bot]");
    expect(uit).toMatch(/^0\|/);
    expect(uit).toContain("voorstel van Dependabot");
  });

  it("dezelfde wijziging door iemand anders blijft rood", () => {
    expect(metRepo(nieuweVersie, "bouwer")).toMatch(
      /^1\|[\s\S]*bestanden die van de gedeelde template/,
    );
  });

  it("een voorstel van dependabot[bot] dat meer wijzigt dan uses:-regels blijft rood", () => {
    const uit = metRepo(
      (tekst) => nieuweVersie(tekst).replace("node-version: 22", "node-version: 20"),
      "dependabot[bot]",
    );
    expect(uit).toMatch(/^1\|[\s\S]*bestanden die van de gedeelde template/);
  });
});
