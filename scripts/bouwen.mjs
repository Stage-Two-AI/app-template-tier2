import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * `pnpm build`: `vite build`, maar zonder de testlogin.
 *
 * De testlogin (`pnpm testlogin`) staat in .env.development.local, dat Vite alleen in de
 * dev-server leest. Staat hij toch in de omgeving of in .env.local (zoals bij
 * `pnpm test:e2e`, dat .env.local inleest), dan zou hij in de gebouwde bestanden komen:
 * src/lib/env.ts geeft heel import.meta.env aan de controle, en dan neemt Vite elke
 * VITE_-waarde op. Een waarde in de omgeving gaat bij Vite vóór elk .env-bestand, dus
 * leeg maken vóór het bouwen houdt hem eruit.
 *
 * Dit staat hier en niet alleen in vite.config.ts, omdat dat bestand van het project is
 * en bij het bijwerken niet meekomt. Dit script komt met elke versie mee.
 */
export const ALLEEN_DEV = ["VITE_TESTLOGIN_EMAIL", "VITE_TESTLOGIN_WACHTWOORD"];

const vite = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
const env = { ...process.env };
for (const naam of ALLEEN_DEV) env[naam] = "";
const r = spawnSync(process.execPath, [vite, "build", ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
});
process.exit(r.status ?? 1);
