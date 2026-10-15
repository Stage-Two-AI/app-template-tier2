import { fail, pass } from "./lib/changed-files.mjs";
import { cloudflareConfig } from "./lib/cloudflare-config.mjs";

/**
 * Houdt `wrangler.jsonc` binnen de afspraken van de stack: alleen de gebouwde
 * bestanden, elk adres achter Access, en geen opslag van Cloudflare zelf (D1, R2, KV,
 * Durable Objects of een sleutel die niet op de lijst staat). Gegevens staan in Supabase.
 *
 * De controle zelf staat in `scripts/lib/cloudflare-config.mjs`; de uitrol gebruikt
 * dezelfde controle als poort. Deze guard draait hem al op de pull request, zodat een
 * app die om opslag vraagt niet kan mergen in plaats van pas bij de uitrol te stranden.
 * Ontbreekt het bestand of is het niet te lezen, dan faalt de guard ook.
 */
let config;
try {
  config = cloudflareConfig();
} catch (fout) {
  fail("wrangler.jsonc houdt zich niet aan de afspraken van de stack.", [
    fout instanceof Error ? fout.message : String(fout),
    "",
    "Gegevens horen in Supabase; Cloudflare serveert alleen de app en regelt de toegang.",
    "Zie de regels in AGENTS.md en de uitleg in docs/WERKWIJZE.md.",
  ]);
}

pass(
  config.stand === "tijdelijk"
    ? `wrangler.jsonc klopt (tijdelijke stand: ${config.worker} op workers.dev, zolang er geen eigen domein is)`
    : `wrangler.jsonc klopt (${config.worker} op ${config.hostname})`,
);
