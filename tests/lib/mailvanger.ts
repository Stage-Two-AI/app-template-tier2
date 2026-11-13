/**
 * De inlogmail uit de lokale mailvanger van Supabase lezen (Mailpit, poort 54324). Lokaal en
 * in CI stuurt Supabase geen mail naar buiten: elke mail komt daar terecht. Zo kan een test
 * echt inloggen met de code of de link uit de mail, zonder omweg.
 *
 * Alleen voor de lokale Supabase. Het adres staat als SUPABASE_MAIL_URL in .env.test
 * (`pnpm env:local`).
 */
export type Inlogmail = { code: string; link: string };

type Zoekresultaat = { messages?: { ID: string }[] };
type Bericht = { HTML?: string };

function basis(adres: string | undefined): string {
  const url = adres || "http://127.0.0.1:54324";
  if (!/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/?$/.test(url)) {
    throw new Error("SUPABASE_MAIL_URL wijst niet naar de lokale mailvanger.");
  }
  return url.replace(/\/$/, "");
}

async function mailsVoor(url: string, email: string): Promise<string[]> {
  const antwoord = await fetch(`${url}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
  if (!antwoord.ok) {
    throw new Error(`De mailvanger op ${url} antwoordt met ${antwoord.status}.`);
  }
  const gevonden = (await antwoord.json()) as Zoekresultaat;
  return (gevonden.messages ?? []).map((mail) => mail.ID);
}

/**
 * Roep dit aan vóórdat de mail verstuurd wordt. Het onthoudt welke mails er al waren en geeft
 * een functie terug die wacht op de eerstvolgende nieuwe mail voor dit adres en de HTML ervan
 * geeft, welk sjabloon het ook is. Komt er binnen de wachttijd geen mail, dan null.
 */
export async function wachtOpBericht(o: {
  email: string;
  mailUrl?: string;
}): Promise<(wachtMs?: number) => Promise<string | null>> {
  const url = basis(o.mailUrl);
  const eerder = new Set(await mailsVoor(url, o.email));

  return async (wachtMs = 15_000) => {
    const tot = Date.now() + wachtMs;
    while (Date.now() < tot) {
      const nieuw = (await mailsVoor(url, o.email)).find((id) => !eerder.has(id));
      if (nieuw) {
        eerder.add(nieuw);
        const antwoord = await fetch(`${url}/api/v1/message/${nieuw}`);
        return ((await antwoord.json()) as Bericht).HTML ?? "";
      }
      await new Promise((klaar) => setTimeout(klaar, 250));
    }
    return null;
  };
}

/** Alle links (href) uit de HTML van een mail. */
export function linksUit(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((treffer) =>
    (treffer[1] ?? "").replaceAll("&amp;", "&"),
  );
}

/**
 * Roep dit aan vóórdat de code wordt aangevraagd. Het onthoudt welke mails er al waren en
 * geeft een functie terug die wacht op de eerstvolgende nieuwe mail voor dit adres, en daar
 * de code van tien cijfers en de link uit haalt.
 *
 *   const leesMail = await wachtOpInlogmail({ email });
 *   ... code aanvragen ...
 *   const { code, link } = await leesMail();
 */
export async function wachtOpInlogmail(o: {
  email: string;
  mailUrl?: string;
}): Promise<() => Promise<Inlogmail>> {
  const leesBericht = await wachtOpBericht(o);

  return async () => {
    const html = await leesBericht();
    if (html === null) {
      throw new Error(
        `Geen nieuwe inlogmail voor ${o.email} in de mailvanger op ${basis(o.mailUrl)}. Draait de lokale Supabase met de mailvanger aan?`,
      );
    }
    const code = /id="code"[^>]*>\s*(\d{10})\s*</.exec(html)?.[1];
    const link = /id="link"[^>]*href="([^"]+)"/.exec(html)?.[1];
    if (!code || !link) {
      throw new Error(
        "De inlogmail bevat geen code of link; zie supabase/templates/inlogcode.html.",
      );
    }
    return { code, link: link.replaceAll("&amp;", "&") };
  };
}
