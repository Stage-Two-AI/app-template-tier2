import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { databaseModus, testDatabase } from "./lib/stack-config.mjs";

/**
 * De preview van de Claude-app: `.claude/launch.json` start dit script, en de app laat
 * het resultaat zien in het venster naast het gesprek. Claude kijkt daar zelf ook mee
 * (schermafbeeldingen, klikken) om zijn werk te controleren.
 *
 * Dit is lokaal kijken voor jezelf (docs/routes/lokaal-kijken.md), niet opleveren: dat
 * blijft de pull request met de Cloudflare-preview. Daarom gaat het hier, buiten `pnpm dev`
 * om: de preview is een bewuste knop in de app, geen dev-server die een agent in Bash
 * opzet om werk te "laten zien".
 *
 * Wat dit script regelt, zodat de gebruiker niets hoeft te weten:
 *   1. de pakketten (`pnpm install`) als die er nog niet zijn;
 *   2. bij een app met database: een .env.local naar de TESTDATABASE (nooit productie),
 *      via `pnpm env:test`, met de publieke sleutel uit stack.config.json, en bij elke
 *      start de testlogin (`pnpm testlogin`), want het wachtwoord wordt elke nacht
 *      vernieuwd;
 *   3. vite op de poort die de app doorgeeft (PORT), of 5173.
 */

const ROOD = (t) => `\u001b[31m${t}\u001b[0m`;
const opWindows = process.platform === "win32";

function pnpm(args) {
  // Op Windows is pnpm een .cmd; zonder shell vindt spawnSync die niet. De argumenten
  // zijn hier altijd vaste woorden uit dit script, dus de shell-regel is veilig.
  if (opWindows) return spawnSync(`pnpm ${args.join(" ")}`, { stdio: "inherit", shell: true });
  return spawnSync("pnpm", args, { stdio: "inherit" });
}

function stop(regels) {
  console.error(["", ...regels.map((r) => `  ${r}`), ""].join("\n"));
  process.exit(1);
}

// 1. Pakketten
if (!existsSync(join("node_modules", "vite", "bin", "vite.js"))) {
  console.log("Pakketten ophalen (eenmalig, duurt even)…");
  if (pnpm(["install"]).status !== 0) {
    stop([
      ROOD("✗ `pnpm install` mislukte."),
      "Draai /stagetwo-tier2:installatie, of vraag Stage Two.",
    ]);
  }
}

// 2. De database: alleen de testdatabase, of een lokale Supabase (variant A)
const modus = databaseModus();
if (modus !== "geen") {
  const test = testDatabase();
  const vers = !existsSync(".env.local") && Boolean(test);
  if (vers) {
    // Schrijft .env.local met de publieke sleutel van de testdatabase; faalt het, dan
    // draait de app zonder database (de startpagina) en zegt het script waarom.
    pnpm(["env:test"]);
  }
  if (existsSync(".env.local")) {
    const inhoud = readFileSync(".env.local", "utf8");
    const url = /^VITE_SUPABASE_URL=(.*)$/m.exec(inhoud)?.[1]?.trim() ?? "";
    const ref = /^https:\/\/([a-z]{20})\.supabase\.co/.exec(url)?.[1] ?? null;
    const lokaal = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?/.test(url);
    const toegestaan = ref === null ? lokaal || url === "" : ref === test?.project_ref;
    if (!toegestaan) {
      stop([
        ROOD("✗ .env.local wijst naar een database die niet de testdatabase is."),
        "",
        `Gevonden: ${url}`,
        test
          ? `De testdatabase van deze app is ${test.url}.`
          : "Deze app heeft geen testdatabase ingesteld (stack.config.json).",
        "",
        "De preview praat nooit met productie: wat je hier aanklikt, gebeurt dan echt.",
        "Verwijder .env.local (dan schrijft de preview hem opnieuw), of vraag Stage Two.",
      ]);
    }
    // Bij elke start de testlogin vernieuwen (in .env.development.local); env:test deed dat
    // net al als hij .env.local schreef. Lukt het niet (offline, geen artifact), dan start de app gewoon.
    if (!vers && ref !== null && ref === test?.project_ref) {
      const r = spawnSync(
        process.execPath,
        [fileURLToPath(new URL("./testlogin.mjs", import.meta.url))],
        {
          stdio: "inherit",
        },
      );
      if (r.status !== 0) {
        console.warn("  ! Geen nieuwe testlogin; de app start, maar inloggen lukt misschien niet.");
      }
    }
  } else {
    console.warn(
      [
        "",
        "  ! Deze app heeft een database, maar de preview heeft er (nog) geen toegang toe.",
        "    De app start zonder gegevens. Vraag Stage Two om de publieke sleutel van de",
        "    testdatabase in stack.config.json (`testdatabase.anon_key`).",
        "",
      ].join("\n"),
    );
  }
}

// 3. Vite, op de poort die de Claude-app doorgeeft
const poort = process.env.PORT || "5173";
const uit = spawnSync(
  process.execPath,
  [join("node_modules", "vite", "bin", "vite.js"), "--port", poort, "--strictPort"],
  { stdio: "inherit" },
);
process.exit(uit.status ?? 1);
