import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
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
