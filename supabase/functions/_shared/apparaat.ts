// Apparaatsleutels: zo roept een machine (een server, een Pi, een script) een Edge Function
// aan zonder als mens in te loggen. Het apparaat stuurt zijn eigen sleutel mee in de kop
// `x-apparaat-sleutel`. In de repo staat alleen de vingerafdruk van die sleutel (SHA-256),
// in apparaten.json. Daaruit is de sleutel niet terug te rekenen, dus dat bestand mag
// openbaar zijn. De sleutel zelf staat alleen op het apparaat.
//
// Een apparaat toevoegen: `pnpm apparaat:nieuw <naam>` (zet de vingerafdruk erbij en toont de
// sleutel één keer). Intrekken: `pnpm apparaat:nieuw -- --intrekken <naam>`. Daarna via een
// pull request; na de merge rolt de beheer-repo de functies opnieuw uit.
//
// Zet bij een functie die dit gebruikt in supabase/config.toml:
//   [functions.<naam>]
//   verify_jwt = false
// want een apparaat heeft geen inlog bij Supabase. Deze controle neemt die taak over.
//
// Deno én Node (de unittests): alleen Web Crypto, geen Deno-API's.
import lijst from "./apparaten.json" with { type: "json" };

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

/** De naam van het apparaat dat dit verzoek doet, of null als de sleutel niet klopt. */
export async function welkApparaat(
  request: Request,
  apparaten: Apparaat[] = lijst.apparaten,
): Promise<string | null> {
  const sleutel = request.headers.get(KOP) ?? "";
  if (sleutel.length < MINIMALE_LENGTE) return null;
  const afdruk = await vingerafdruk(sleutel);
  let gevonden: string | null = null;
  for (const a of apparaten) if (gelijk(afdruk, a.sha256.toLowerCase())) gevonden = a.naam;
  return gevonden;
}

/** Een 401-antwoord voor een verzoek zonder geldige apparaatsleutel. */
export function geenToegang(): Response {
  return new Response(JSON.stringify({ error: "Geen geldige apparaatsleutel" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}
