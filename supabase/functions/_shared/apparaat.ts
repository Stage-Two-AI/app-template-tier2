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
// In een functie: `const apparaat = await welkApparaat(request, ["pi-kantoor"])`; null = weigeren.
//
// Zet bij een functie die dit gebruikt in supabase/config.toml:
//   [functions.<naam>]
//   verify_jwt = false
// want een apparaat heeft geen inlog bij Supabase. Deze controle neemt die taak over.
//
// De werking zelf staat in apparaat-kern.ts (getest in tests/unit/apparaat.test.ts); dit
// bestand voegt de lijst uit apparaten.json toe.

import { type Apparaat, welkApparaat as welkApparaatUit } from "./apparaat-kern.ts";
import lijst from "./apparaten.json" with { type: "json" };

export { type Apparaat, geenToegang, KOP, MINIMALE_LENGTE, vingerafdruk } from "./apparaat-kern.ts";

/**
 * De naam van het apparaat dat dit verzoek doet, of null als de sleutel niet klopt of het
 * apparaat niet bij `toegestaan` hoort. Noem altijd welke apparaten deze functie mogen
 * gebruiken: anders kan elk apparaat uit de lijst elke functie aanroepen.
 */
export function welkApparaat(
  request: Request,
  toegestaan: readonly string[],
  apparaten: readonly Apparaat[] = lijst.apparaten,
): Promise<string | null> {
  return welkApparaatUit(request, toegestaan, apparaten);
}
