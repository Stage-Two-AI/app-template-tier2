import { afterEach, describe, expect, it, vi } from "vitest";
import { envSchema, omgevingsfout } from "./env";
import { Omgevingsfout, toonStartfout } from "./startfout";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

/** Zoals lib/env.ts weigert bij het opstarten; main.tsx geeft die fout aan toonStartfout. */
function foutBij(waarden: Record<string, string>): Omgevingsfout {
  const uitkomst = envSchema.safeParse(waarden);
  if (uitkomst.success) throw new Error("Deze waarden kloppen; geen fout.");
  return omgevingsfout(uitkomst.error.issues);
}

describe("toonStartfout: geen witte pagina als de app niet kan starten", () => {
  it("zet de melding op het scherm, als tekst", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const doel = document.createElement("div");
    document.body.append(doel);
    toonStartfout(new Omgevingsfout("<b>x</b>", ["<b>VITE_X</b>"]), doel);
    const melding = doel.querySelector('[role="alert"]');
    expect(melding).toHaveTextContent("Deze app kan niet starten");
    expect(melding).toHaveTextContent("De instellingen van deze versie kloppen niet");
    // Als tekst, nooit als opmaak.
    expect(doel.querySelector("b")).toBeNull();
  });

  it("een onbekende dienst in VITE_INLOGDIENST: op het scherm alleen de naam, in de console alles", () => {
    const console_ = vi.spyOn(console, "error").mockImplementation(() => {});
    const fout = foutBij({ VITE_INLOGDIENST: "cloudflare,sso" });
    toonStartfout(fout);
    expect(document.body).toHaveTextContent("kloppen niet (VITE_INLOGDIENST)");
    expect(document.body).not.toHaveTextContent("sso");
    expect(console_).toHaveBeenCalledWith(fout);
    expect(fout.message).toContain('VITE_INLOGDIENST kent "sso" niet');
    expect(fout.message).toContain("Kies uit: cloudflare, azure, google, mailcode, wachtwoord");
  });

  it("het openbare scherm toont geen waarde en geen aanwijzingen voor ontwikkelaars", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const verkeerdGeplakt = "0x4AAAAAAA-geheim-van-de-widget";
    toonStartfout(
      foutBij({ VITE_INLOGDIENST: verkeerdGeplakt, VITE_SUPABASE_ANON_KEY: "kort-geheim" }),
    );
    const scherm = document.body.textContent ?? "";
    for (const verboden of [verkeerdGeplakt, "kort-geheim", ".env.local", "pnpm env:local"]) {
      expect(scherm).not.toContain(verboden);
    }
    expect(scherm).toContain("VITE_INLOGDIENST");
    expect(scherm).toContain("VITE_SUPABASE_ANON_KEY");
  });

  it("ook bij een fout van zod zelf staat de naam van de variabele op het scherm, niet de waarde", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    toonStartfout(foutBij({ VITE_SUPABASE_SCHEMA: "geheim_schema" }));
    expect(document.body).toHaveTextContent("kloppen niet (VITE_SUPABASE_SCHEMA)");
    expect(document.body).not.toHaveTextContent("geheim_schema");
  });

  it("een andere fout bij het opstarten: een algemene tekst, de fout zelf alleen in de console", () => {
    const console_ = vi.spyOn(console, "error").mockImplementation(() => {});
    const fout = new Error("Kopieer .env.example naar .env.local; geheim=abc");
    toonStartfout(fout);
    expect(document.body).toHaveTextContent("Er ging iets mis bij het opstarten");
    expect(document.body).not.toHaveTextContent("geheim");
    expect(document.body).not.toHaveTextContent(".env.local");
    expect(console_).toHaveBeenCalledWith(fout);
  });
});
