import http from "node:http";

/**
 * Een nagebootste inlogdienst voor de tests van het klantportaal: een klein servertje dat
 * doet wat Cloudflare Access voor Supabase doet (een code omwisselen voor een token, en
 * zeggen wie er is ingelogd). De lokale Supabase Auth praat er echt mee: ze doorloopt de
 * hele terugkeer van een inlogdienst en begint zelf de sessie. Zo schrijft Supabase zelf op
 * dat die sessie via een inlogdienst begon (`oauth`), en niet de test.
 *
 * Waarom dit niet onder de naam `custom:cloudflare` kan: Supabase Auth neemt voor een eigen
 * inlogdienst (custom provider) alleen een adres met https aan dat niet naar deze computer
 * of een intern netwerk wijst (internal/utilities/url_validator.go). Lokaal en in CI is er
 * alleen deze computer. Daarom hangt de dienst lokaal in het vak `keycloak`, het enige vak
 * waar een eigen adres zonder https in past (supabase/config.toml, [auth.external.keycloak]).
 * Voor Supabase Auth is de weg daarna dezelfde: dezelfde terugkeer, dezelfde koppeling aan
 * een account, dezelfde sessie. Alleen de naam van de dienst verschilt; zie
 * `noemIdentiteitCloudflare` in sessies.ts.
 *
 * De dienst gelooft alles wat de test hem vertelt: de "code" is gewoon de persoon zelf. Hij
 * draait alleen zolang de test loopt en kent geen geheimen.
 */

/** Dezelfde poort als in supabase/config.toml, [auth.external.keycloak]. */
export const POORT_INLOGDIENST = 54390;

export type Persoon = {
  /** Het vaste kenmerk van deze persoon bij de inlogdienst. */
  sub: string;
  email: string;
  /**
   * Zegt de dienst erbij dat het adres gecontroleerd is? Cloudflare Access doet dat niet;
   * laat het dus weg om Cloudflare na te doen.
   */
  email_verified?: boolean;
};

export function codeVoor(persoon: Persoon): string {
  return Buffer.from(JSON.stringify(persoon)).toString("base64url");
}

function persoonUit(code: string): Persoon | null {
  try {
    const gelezen: unknown = JSON.parse(Buffer.from(code, "base64url").toString("utf8"));
    if (typeof gelezen !== "object" || gelezen === null) return null;
    const { sub, email } = gelezen as Record<string, unknown>;
    return typeof sub === "string" && typeof email === "string" ? (gelezen as Persoon) : null;
  } catch {
    return null;
  }
}

export type NepInlogdienst = { stop: () => Promise<void> };

export function startNepInlogdienst(): Promise<NepInlogdienst> {
  const server = http.createServer((vraag, antwoord) => {
    let body = "";
    vraag.on("data", (stuk) => {
      body += String(stuk);
    });
    vraag.on("end", () => {
      const pad = (vraag.url ?? "").split("?")[0] ?? "";
      antwoord.setHeader("content-type", "application/json");
      if (vraag.method === "POST" && pad.endsWith("/protocol/openid-connect/token")) {
        const code = new URLSearchParams(body).get("code") ?? "";
        if (!persoonUit(code)) {
          antwoord.statusCode = 400;
          antwoord.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        antwoord.end(JSON.stringify({ access_token: code, token_type: "bearer", expires_in: 300 }));
        return;
      }
      if (pad.endsWith("/protocol/openid-connect/userinfo")) {
        const token = (vraag.headers.authorization ?? "").replace(/^Bearer /i, "");
        const persoon = persoonUit(token);
        if (!persoon) {
          antwoord.statusCode = 401;
          antwoord.end(JSON.stringify({ error: "invalid_token" }));
          return;
        }
        antwoord.end(JSON.stringify({ name: persoon.email, ...persoon }));
        return;
      }
      antwoord.statusCode = 404;
      antwoord.end("{}");
    });
  });
  return new Promise((klaar, mislukt) => {
    server.once("error", (fout) =>
      mislukt(
        new Error(
          `De nagebootste inlogdienst kon niet starten op poort ${POORT_INLOGDIENST}: ${fout.message}`,
        ),
      ),
    );
    // Op alle adressen van deze computer: Supabase Auth draait in Docker en komt van buiten
    // de eigen lus (host.docker.internal).
    server.listen(POORT_INLOGDIENST, "0.0.0.0", () => {
      klaar({
        stop: () =>
          new Promise((gestopt) => {
            server.closeAllConnections();
            server.close(() => gestopt());
          }),
      });
    });
  });
}
