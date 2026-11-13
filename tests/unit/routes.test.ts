import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * De vaste routes in docs/routes/ komen alleen bij een agent terecht als ze met elke versie
 * meegaan (.claude/stack-manifest.json, `vervangen`) en als AGENTS.md ze noemt, in het deel
 * tussen de markeringen dat ook met elke versie meegaat. Een nieuwe route die op een van die
 * twee plekken ontbreekt, bestaat voor een app niet.
 *
 * Deze test is van de template en komt met elke versie mee.
 */
const WORTEL = resolve(__dirname, "../..");
const lees = (pad: string) => readFileSync(resolve(WORTEL, pad), "utf8");

const routes = readdirSync(resolve(WORTEL, "docs/routes"))
  .filter((naam) => naam.endsWith(".md"))
  .map((naam) => `docs/routes/${naam}`)
  .sort();

const manifest = JSON.parse(lees(".claude/stack-manifest.json")) as {
  vanDeTemplate: { vervangen: string[] };
};

const agents = lees("AGENTS.md");
const vanDeTemplate = agents.slice(
  agents.indexOf("<!-- stack:begin -->"),
  agents.indexOf("<!-- stack:end -->"),
);

describe("de routes in docs/routes/", () => {
  it("er zijn routes, en AGENTS.md heeft de markeringen", () => {
    expect(routes.length).toBeGreaterThan(0);
    expect(vanDeTemplate.length).toBeGreaterThan(0);
  });

  it.each(routes)("%s gaat mee met elke versie (stack-manifest, vervangen)", (route) => {
    expect(manifest.vanDeTemplate.vervangen).toContain(route);
  });

  it.each(routes)("%s staat in AGENTS.md, tussen de markeringen", (route) => {
    expect(vanDeTemplate).toContain(`\`${route}\``);
  });

  it("elke route die AGENTS.md noemt, bestaat", () => {
    const genoemd = [...vanDeTemplate.matchAll(/`(docs\/routes\/[\w-]+\.md)`/g)].map((m) => m[1]);
    for (const route of genoemd) expect(existsSync(resolve(WORTEL, route ?? "")), route).toBe(true);
  });

  it.each(routes)("%s heeft geen em-dash (huisstijl)", (route) => {
    expect(lees(route)).not.toContain("—");
  });
});
