import { describe, expect, it } from "vitest";
import {
  antwoordOpPreflight,
  corsHeaders,
  jsonAntwoord,
} from "../../supabase/functions/_shared/cors";

/**
 * Een Edge Function die de browser aanroept, beantwoordt zelf de preflight. Zonder
 * dat antwoord weigert de browser de aanroep, ook al werkt hij met curl.
 */
describe("CORS in de Edge Functions", () => {
  it("beantwoordt een OPTIONS-verzoek met 200 en de CORS-headers", () => {
    const antwoord = antwoordOpPreflight(new Request("https://x.test/f", { method: "OPTIONS" }));
    expect(antwoord?.status).toBe(200);
    expect(antwoord?.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(antwoord?.headers.get("Access-Control-Allow-Headers")).toContain("authorization");
    expect(antwoord?.headers.get("Access-Control-Allow-Headers")).toContain("apikey");
  });

  it("laat een gewone aanroep door", () => {
    expect(antwoordOpPreflight(new Request("https://x.test/f", { method: "POST" }))).toBeNull();
  });

  it("zet de CORS-headers ook op een gewoon antwoord, ook bij een fout", async () => {
    const antwoord = jsonAntwoord({ error: "Niet ingelogd" }, 401);
    expect(antwoord.status).toBe(401);
    expect(antwoord.headers.get("content-type")).toBe("application/json");
    for (const [naam, waarde] of Object.entries(corsHeaders)) {
      expect(antwoord.headers.get(naam)).toBe(waarde);
    }
    expect(await antwoord.json()).toEqual({ error: "Niet ingelogd" });
  });
});
