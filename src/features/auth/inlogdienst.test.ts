import { describe, expect, it, vi } from "vitest";
import { type InlogAuth, inlogVorm, leesInlogdiensten, startInloggen } from "./inlogdienst";

function nepAuth(fout: { message: string } | null = null) {
  return {
    signInWithOAuth: vi.fn().mockResolvedValue({ data: {}, error: fout }),
    signInWithOtp: vi.fn().mockResolvedValue({ data: {}, error: fout }),
  } satisfies InlogAuth;
}

const TERUG = "https://app.klant.nl/";

describe("startInloggen", () => {
  it("stuurt bij cloudflare door naar de custom provider, terug naar de app", async () => {
    const auth = nepAuth();
    await startInloggen("cloudflare", auth, { terugNaar: TERUG });
    expect(auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: "custom:cloudflare",
      options: { redirectTo: TERUG },
    });
  });

  it("gebruikt bij azure en google de gewone provider", async () => {
    for (const dienst of ["azure", "google"] as const) {
      const auth = nepAuth();
      await startInloggen(dienst, auth, { terugNaar: TERUG });
      expect(auth.signInWithOAuth).toHaveBeenCalledWith(
        expect.objectContaining({ provider: dienst }),
      );
    }
  });

  it("stuurt bij mailcode een link en laat een nieuwe gebruiker toe", async () => {
    // Wie erin mag, bewaakt de server (de before-user-created-hook van de inrichting),
    // niet de browser: een instelling in de browser is geen beveiliging.
    const auth = nepAuth();
    await startInloggen("mailcode", auth, { terugNaar: TERUG, email: "piet@klant.nl" });
    expect(auth.signInWithOtp).toHaveBeenCalledWith({
      email: "piet@klant.nl",
      options: { emailRedirectTo: TERUG, shouldCreateUser: true },
    });
  });

  it("weigert mailcode zonder e-mailadres", async () => {
    const auth = nepAuth();
    await expect(startInloggen("mailcode", auth, { terugNaar: TERUG })).rejects.toThrow(
      "e-mailadres",
    );
    expect(auth.signInWithOtp).not.toHaveBeenCalled();
  });

  it("geeft een fout van Supabase door", async () => {
    const auth = nepAuth({ message: "provider niet gevonden" });
    await expect(startInloggen("cloudflare", auth, { terugNaar: TERUG })).rejects.toThrow(
      "provider niet gevonden",
    );
  });

  it("weigert wachtwoord: dat gaat via het formulier", async () => {
    await expect(startInloggen("wachtwoord", nepAuth(), { terugNaar: TERUG })).rejects.toThrow();
  });
});

describe("inlogVorm", () => {
  it("koppelt elke dienst aan de juiste vorm van de loginpagina", () => {
    expect(inlogVorm("cloudflare")).toBe("doorsturen");
    expect(inlogVorm("azure")).toBe("knop");
    expect(inlogVorm("google")).toBe("knop");
    expect(inlogVorm("mailcode")).toBe("mailcode");
    expect(inlogVorm("wachtwoord")).toBe("wachtwoord");
  });
});

describe("leesInlogdiensten", () => {
  it("leest één dienst als een lijst met die ene dienst", () => {
    for (const dienst of ["cloudflare", "azure", "google", "mailcode", "wachtwoord"] as const) {
      expect(leesInlogdiensten(dienst)).toEqual({ ok: true, diensten: [dienst] });
    }
  });

  it("leest een lijst met komma's, in de opgegeven volgorde, spaties mogen", () => {
    expect(leesInlogdiensten("cloudflare,mailcode")).toEqual({
      ok: true,
      diensten: ["cloudflare", "mailcode"],
    });
    expect(leesInlogdiensten(" mailcode , cloudflare ")).toEqual({
      ok: true,
      diensten: ["mailcode", "cloudflare"],
    });
  });

  it("weigert een onbekende dienst, een lege plek en een dubbele", () => {
    for (const tekst of ["okta", "cloudflare,okta", "cloudflare,", ",", "cloudflare,cloudflare"]) {
      expect(leesInlogdiensten(tekst).ok, tekst).toBe(false);
    }
  });

  it("weigert wachtwoord naast een andere dienst: dat is alleen voor lokaal en de tests", () => {
    const uitkomst = leesInlogdiensten("cloudflare,wachtwoord");
    expect(uitkomst.ok).toBe(false);
    if (!uitkomst.ok) expect(uitkomst.fout).toContain("wachtwoord");
  });
});
