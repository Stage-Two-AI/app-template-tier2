// LET OP: deze map draait op Deno. Dit bestand gebruikt alleen standaard-JavaScript, zodat de
// unittests het in Node kunnen lezen (tests/unit/cors.test.ts).
//
// Een Edge Function die de browser aanroept (`supabase.functions.invoke` vanuit de app), krijgt
// eerst een OPTIONS-verzoek: de preflight. Supabase beantwoordt die niet zelf
// (supabase.com/docs/guides/functions/cors). Zonder antwoord weigert de browser de echte
// aanroep. Begin zo'n functie dus met `antwoordOpPreflight`, en zet `corsHeaders` op elk
// antwoord. Een functie die alleen een server of apparaat aanroept, heeft dit niet nodig.
//
// `*` als herkomst is hier veilig: de functie leest wie er belt uit de Authorization-header,
// niet uit een cookie, dus een andere site kan niets doen namens een ingelogde gebruiker.

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** Het antwoord op de preflight, of null als dit geen preflight is. */
export function antwoordOpPreflight(request: Request): Response | null {
  if (request.method !== "OPTIONS") return null;
  return new Response("ok", { headers: corsHeaders });
}

/** Een JSON-antwoord met de CORS-headers erop. */
export function jsonAntwoord(inhoud: unknown, status = 200): Response {
  return new Response(JSON.stringify(inhoud), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}
