import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CODE_GELDIG_MS, CODE_LENGTE } from "../../src/features/auth/mailcode";

/**
 * Lokaal en in CI moet inloggen met een code per mail hetzelfde gaan als in productie: tien
 * cijfers, een kwartier geldig, één mail met code en link, en de mail in de lokale
 * mailvanger. Deze test houdt supabase/config.toml, het mailsjabloon, de inlogpagina en de
 * CI bij elkaar; de echte inlog test e2e/klantportaal.spec.ts.
 */
const WORTEL = resolve(__dirname, "../..");
const lees = (pad: string) => readFileSync(resolve(WORTEL, pad), "utf8");

function blok(toml: string, naam: string): string {
  const begin = toml.indexOf(`\n[${naam}]\n`);
  if (begin < 0) return "";
  const rest = toml.slice(begin + 1);
  const einde = rest.indexOf("\n[", 1);
  return einde < 0 ? rest : rest.slice(0, einde);
}

describe("supabase/config.toml: de mailcode lokaal", () => {
  const toml = lees("supabase/config.toml");
  const email = blok(toml, "auth.email");

  it("tien cijfers en een kwartier, net als de inlogpagina zegt", () => {
    expect(email).toMatch(new RegExp(`^otp_length = ${CODE_LENGTE}$`, "m"));
    expect(email).toMatch(new RegExp(`^otp_expiry = ${CODE_GELDIG_MS / 1000}$`, "m"));
  });

  it("een nieuw adres moet eerst bevestigd worden, zoals in productie", () => {
    expect(email).toMatch(/^enable_confirmations = true$/m);
  });

  it("de mailvanger staat aan", () => {
    expect(blok(toml, "local_smtp")).toMatch(/^enabled = true$/m);
  });

  it("eerste aanmelding en terugkerende klant krijgen dezelfde mail, met code en link", () => {
    for (const soort of ["confirmation", "magic_link", "recovery"]) {
      const sjabloon = blok(toml, `auth.email.template.${soort}`);
      expect(sjabloon, soort).toContain('content_path = "./supabase/templates/inlogcode.html"');
    }
    const mail = lees("supabase/templates/inlogcode.html");
    expect(mail).toContain('<span id="code">{{ .Token }}</span>');
    // Zoals de mail in productie: het adres van de app zelf, nooit wat de aanvrager opgeeft.
    expect(mail).toContain(
      'id="link" href="{{ .SiteURL }}/login?token_hash={{ .TokenHash }}&type=email"',
    );
    expect(mail.split("-->")[1]).not.toContain("RedirectTo");
  });

  it("de mail belooft niet dat de code of de link maar één keer werkt", () => {
    // Na elkaar is dat zo, maar gelijktijdig gebruik kan Supabase niet uitsluiten.
    const mail = lees("supabase/templates/inlogcode.html").split("-->")[1] ?? "";
    expect(mail).not.toMatch(/één keer|eenmalig/i);
    expect(mail).toContain("een kwartier geldig");
  });

  it("de link in de mail gaat naar de poort waarop de browsertest het klantportaal draait", () => {
    const poort = /const PORT_KLANTPORTAAL = (\d+);/.exec(lees("playwright.config.ts"))?.[1];
    expect(poort).toBeDefined();
    expect(blok(toml, "auth")).toMatch(
      new RegExp(`^site_url = "http://127\\.0\\.0\\.1:${poort}"$`, "m"),
    );
    expect(toml).toContain(`"http://127.0.0.1:${poort}/login"`);
  });
});

describe("supabase/config.toml: de nagebootste inlogdienst van de RLS-test", () => {
  it("wijst naar de poort waarop de test de dienst start, en nergens anders heen", () => {
    const dienst = blok(lees("supabase/config.toml"), "auth.external.keycloak");
    const poort = /POORT_INLOGDIENST = (\d+);/.exec(lees("tests/rls/lib/inlogdienst-nep.ts"))?.[1];
    expect(poort).toBeDefined();
    expect(dienst).toMatch(/^enabled = true$/m);
    expect(dienst).toContain(`url = "http://host.docker.internal:${poort}/`);
  });
});

describe("CI: de mailvanger draait mee", () => {
  it("supabase start sluit de mailvanger niet uit", () => {
    const start = /supabase start -x (\S+)/.exec(lees(".github/workflows/ci.yml"))?.[1] ?? "";
    expect(start).not.toBe("");
    expect(start.split(",")).not.toContain("mailpit");
    expect(start.split(",")).not.toContain("inbucket");
  });

  it("pnpm env:local geeft de tests het adres van de mailvanger", () => {
    expect(lees("scripts/write-local-env.mjs")).toContain("SUPABASE_MAIL_URL=");
  });
});
