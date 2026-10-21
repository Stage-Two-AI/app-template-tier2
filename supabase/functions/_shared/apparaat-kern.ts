// De kern van de apparaatsleutels, zonder de lijst met apparaten: zie apparaat.ts voor de
// uitleg en het gebruik in een functie. Los van apparaten.json, zodat de unittests en de
// typecontrole ook werken in een app die nog geen apparaten heeft (dat bestand is van het
// project en ontstaat bij het eerste `pnpm apparaat:nieuw`).
//
// Deno én Node (de unittests): alleen Web Crypto, geen Deno-API's.
export type Apparaat = { naam: string; sha256: string };

export const KOP = "x-apparaat-sleutel";
/** Korter dan dit is geen sleutel van `pnpm apparaat:nieuw` (32 bytes, base64url). */
export const MINIMALE_LENGTE = 40;

/** De vingerafdruk (SHA-256, hex) van een sleutel. */
export async function vingerafdruk(sleutel: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sleutel));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Vergelijkt zonder vroeg te stoppen, zodat de duur niets verraadt. */
function gelijk(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let verschil = 0;
  for (let i = 0; i < a.length; i += 1) verschil |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return verschil === 0;
}

/**
 * De naam van het apparaat dat dit verzoek doet, of null als de sleutel niet klopt of het
 * apparaat niet bij `toegestaan` hoort. Noem altijd welke apparaten deze functie mogen
 * gebruiken: anders kan elk apparaat uit de lijst elke functie aanroepen.
 */
export async function welkApparaat(
  request: Request,
  toegestaan: readonly string[],
  apparaten: readonly Apparaat[],
): Promise<string | null> {
  const sleutel = request.headers.get(KOP) ?? "";
  if (sleutel.length < MINIMALE_LENGTE) return null;
  const afdruk = await vingerafdruk(sleutel);
  let gevonden: string | null = null;
  for (const a of apparaten) if (gelijk(afdruk, a.sha256.toLowerCase())) gevonden = a.naam;
  return gevonden && toegestaan.includes(gevonden) ? gevonden : null;
}

/** Een 401-antwoord voor een verzoek zonder geldige apparaatsleutel. */
export function geenToegang(): Response {
  return new Response(JSON.stringify({ error: "Geen geldige apparaatsleutel" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}
