/**
 * Welke template een app is, en dus welke controle van `wrangler.jsonc` geldt. Tier 2 heeft er
 * twee: de gewone (een single-page app: alleen gebouwde bestanden, geen `main`) en de openbare
 * (`app-template-tier2-openbaar`: één Worker met servercode, `main` verplicht). De rest van de
 * inrichting is voor beide gelijk: ze werkt met de Worker-naam, de stand en het eigen domein.
 *
 * De variant komt uit het manifest van de app (`.claude/stack-manifest.json`, veld `variant`);
 * de workflow leest dat en geeft `--variant cloudflare-openbaar` mee. Zonder `--variant` geldt
 * de gewone controle, precies zoals tot en met versie 43. De inrichting raadt de variant nooit
 * uit `wrangler.jsonc` zelf: een gewone app die per ongeluk een `main` krijgt, blijft geweigerd.
 *
 * `cloudflare-config-openbaar.mjs` is een letterlijke kopie van `scripts/lib/cloudflare-config.mjs`
 * uit `app-template-tier2-openbaar` (die template is de bron; wijzig de kopie hier nooit met de
 * hand). De bewaker van de werkplaats (`bin/verschil-tier2-openbaar.mjs`) wordt rood als de twee
 * uit elkaar lopen.
 */
import { cloudflareConfig as gewoon } from "../../scripts/lib/cloudflare-config.mjs";
import { cloudflareConfig as openbaar } from "./cloudflare-config-openbaar.mjs";

export const GEWOON = "cloudflare";
export const OPENBAAR = "cloudflare-openbaar";

const CONTROLES = { [GEWOON]: gewoon, [OPENBAAR]: openbaar };

/** Keurt de waarde van `--variant` goed. Geen waarde (null of undefined) is de gewone app. */
export function valideerVariant(variant) {
  if (variant === null || variant === undefined) return null;
  if (!Object.hasOwn(CONTROLES, variant)) {
    throw new Error(
      `--variant kent "${variant}" niet. Kies ${GEWOON} (de gewone template) of ${OPENBAAR} (app-template-tier2-openbaar); het staat in .claude/stack-manifest.json van de app.`,
    );
  }
  return variant;
}

/**
 * Leest en controleert `wrangler.jsonc` met de controle van de variant. Geeft
 * `{ worker, stand, hostname }`, voor beide varianten in dezelfde vorm.
 */
export function wranglerConfig(variant, pad = "wrangler.jsonc") {
  return CONTROLES[valideerVariant(variant) ?? GEWOON](pad);
}
