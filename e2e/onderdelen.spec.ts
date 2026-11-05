import { expect, test } from "@playwright/test";
import { ONDERDELEN } from "../src/onderdelen";
import { inloggen } from "./inloggen";
import { databaseModus } from "./stack-config";

// Zonder database is er niets om in te loggen; dan geldt e2e/start.spec.ts.
test.skip(databaseModus() === "geen", "deze app heeft geen database; zie e2e/start.spec.ts");

/**
 * Elk onderdeel van de app (src/onderdelen.ts) in een echte browser: het hoofdscherm opent
 * zonder fout en toont zijn kop. Dat vangt de meeste breuken: een route die weg is, rechten
 * die niet kloppen, een query op een kolom die niet meer bestaat.
 *
 * Een nieuw onderdeel hoeft hier niets: een regel in src/onderdelen.ts is genoeg.
 * Deze test is van de template en komt met elke versie mee.
 */
for (const o of ONDERDELEN) {
  test(`${o.naam}: het hoofdscherm opent zonder fout`, async ({ page }) => {
    const fouten: string[] = [];
    page.on("pageerror", (e) => fouten.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") fouten.push(m.text());
    });

    await inloggen(page);
    await page.goto(o.pad);
    await expect(page.getByRole("heading", { level: 1, name: o.kop ?? o.naam })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(fouten, "fouten in de browser").toEqual([]);
  });
}
