import { afterEach, describe, expect, it, vi } from "vitest";
import { envSchema } from "./env";
import { toonStartfout } from "./startfout";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("toonStartfout: geen witte pagina als de app niet kan starten", () => {
  it("zet de melding op het scherm, als tekst", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const doel = document.createElement("div");
    document.body.append(doel);
    toonStartfout(new Error("De omgevingsvariabelen kloppen niet:\n- <b>x</b>"), doel);
    const melding = doel.querySelector('[role="alert"]');
    expect(melding).toHaveTextContent("Deze app kan niet starten");
    expect(melding).toHaveTextContent("De omgevingsvariabelen kloppen niet");
    // Als tekst, nooit als opmaak.
    expect(doel.querySelector("b")).toBeNull();
  });

  it("een onbekende dienst in de lijst van VITE_INLOGDIENST geeft een melding die zegt wat er mis is", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Zo weigert lib/env.ts bij het opstarten; main.tsx geeft die fout aan toonStartfout.
    const uitkomst = envSchema.safeParse({ VITE_INLOGDIENST: "cloudflare,sso" });
    expect(uitkomst.success).toBe(false);
    const regels = uitkomst.error?.issues.map((issue) => `- ${issue.message}`).join("\n");
    toonStartfout(new Error(`De omgevingsvariabelen kloppen niet:\n${regels}`));
    expect(document.body).toHaveTextContent('VITE_INLOGDIENST kent "sso" niet');
    expect(document.body).toHaveTextContent(
      "Kies uit: cloudflare, azure, google, mailcode, wachtwoord",
    );
  });
});
