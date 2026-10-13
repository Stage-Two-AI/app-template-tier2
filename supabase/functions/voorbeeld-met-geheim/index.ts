// LET OP: deze map draait op Deno, niet op Node en niet in de browser.
// Imports uit src/ werken hier niet, en imports uit deze map werken niet in src/.
// Dit geldt voor álle Supabase Edge Functions, het is geen eigenaardigheid van
// dit project. Zie CLAUDE.md.
//
// Waarvoor je deze map gebruikt: alles wat een geheime sleutel nodig heeft.
// Een betaalprovider, een AI-API, een koppeling met een systeem van de klant,
// webhooks. Dat mag nooit in de app-bundel, want die is voor iedereen leesbaar.
//
// Live zetten: na de merge de workflow "Functies uitrollen" in de beheer-repo (zie AGENTS.md).
// De geheime sleutel zet de owner van de organisatie bij Supabase; dat is een
// architectuurwijziging en geen werk vanaf de computer van de bouwer.

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Alleen POST" }), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
  }

  // De sleutel komt uit de omgeving van de functie, nooit uit de app.
  const apiKey = Deno.env.get("MIJN_API_SLEUTEL");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "MIJN_API_SLEUTEL is niet gezet" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  // Wie roept dit aan? De Authorization-header komt van de ingelogde gebruiker.
  const authorization = request.headers.get("Authorization");
  if (!authorization) {
    return new Response(JSON.stringify({ error: "Niet ingelogd" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json" },
  });
});
