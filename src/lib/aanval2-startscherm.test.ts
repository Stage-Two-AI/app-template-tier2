import { afterEach, describe, expect, it, vi } from "vitest";
import { envSchema } from "./env";
import { toonStartfout } from "./startfout";

/**
 * AANVAL ronde 2, doel 5d: het startscherm bij een fout in de omgeving (main.tsx, env.ts,
 * startfout.ts). Bij een klantportaal ziet iedereen op internet dit scherm. Toont het waarden
 * van variabelen?
 */
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

/** Zoals lib/env.ts de melding opbouwt en main.tsx hem toont. */
function startscherm(waarden: Record<string, string>): string {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const uitkomst = envSchema.safeParse(waarden);
  if (uitkomst.success) return "";
  const details = uitkomst.error.issues.map((issue) => `- ${issue.message}`).join("\n");
  toonStartfout(
    new Error(
      `De omgevingsvariabelen kloppen niet:\n${details}\n\nKopieer .env.example naar .env.local en vul de waarden in, of draai \`pnpm env:local\` als je lokaal met Supabase werkt.`,
    ),
  );
  return document.body.textContent ?? "";
}

describe("AANVAL 5d: het startscherm bij een fout in de omgeving", () => {
  it("5.10 GELUKT ALS: de waarde van VITE_INLOGDIENST staat letterlijk op het openbare scherm (bijvoorbeeld een sleutel die in het verkeerde vak is geplakt)", () => {
    // De owner plakt bij het inrichten een geheim in de verkeerde variabele.
    const verkeerdGeplakt = "0x4AAAAAAA-geheim-van-de-widget";
    const scherm = startscherm({ VITE_INLOGDIENST: verkeerdGeplakt });
    expect(scherm).toContain(verkeerdGeplakt);
  });

  it("5.11 GELUKT ALS: een bezoeker van het klantportaal krijgt aanwijzingen voor ontwikkelaars te zien (.env.local, pnpm env:local)", () => {
    const scherm = startscherm({ VITE_INLOGDIENST: "cloudflare,mailcode,sso" });
    expect(scherm).toContain(".env.local");
    expect(scherm).toContain("pnpm env:local");
  });

  it("5.12 MISLUKT: de andere variabelen (sleutel van Supabase, testlogin, schema, omgeving) komen niet met hun waarde op het scherm", () => {
    const scherm = startscherm({
      VITE_SUPABASE_URL: "https://voorbeeld.supabase.co",
      VITE_SUPABASE_ANON_KEY: "kort-geheim",
      VITE_SUPABASE_SCHEMA: "geheim_schema",
      VITE_OMGEVING: "geheime-omgeving",
      VITE_TESTLOGIN_EMAIL: "testgebruiker@stagetwo.nl",
      VITE_TESTLOGIN_WACHTWOORD: "geheim-wachtwoord-van-de-testgebruiker",
    });
    expect(scherm).toContain("VITE_SUPABASE_ANON_KEY is te kort");
    for (const waarde of [
      "kort-geheim",
      "geheim_schema",
      "geheime-omgeving",
      "geheim-wachtwoord-van-de-testgebruiker",
      "voorbeeld.supabase.co",
    ]) {
      expect(scherm).not.toContain(waarde);
    }
  });
});
