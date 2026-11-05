/**
 * Foutbewaking (Sentry) per app: één Sentry-project per app in de organisatie van de klant,
 * met een eigen DSN. Met één gedeelde DSN zie je in Sentry niet uit welke app een fout komt.
 *
 * Werkt alleen als de omgeving beheer een sleutel heeft (`SENTRY_AUTH_TOKEN`, met
 * `SENTRY_ORG`). Zonder sleutel doet dit niets; de inrichting zegt dan in de samenvatting
 * dat Sentry nog niet gekoppeld is. Een DSN die er al staat (met de hand gezet) blijft
 * staan: dit vult alleen aan wat ontbreekt.
 *
 * Na het koppelen één proefmelding rechtstreeks naar de DSN, en kijken of hij in Sentry
 * aankomt. Zo is bewezen dat de DSN klopt, niet alleen dat de variabele bestaat.
 *
 * Dit bestand staat in twee repo's, gelijk: `app-template-tier2/beheer/lib/` (tier 2) en
 * `beheer-template/klant-tier1/beheer/lib/` (tier 1, en bin/sentry-proef.mjs voor de
 * overdracht). Geen dependencies: Node 22.
 */
import { randomBytes } from "node:crypto";
import { vraag, wacht } from "./vraag.mjs";

/** sentry.io (VS); een organisatie in de EU gebruikt https://de.sentry.io (SENTRY_URL). */
export const SENTRY_URL = "https://sentry.io";
const SLUG = /^[a-z0-9][a-z0-9_-]{0,49}$/;

/** Een DSN uit elkaar: `https://<sleutel>@<host>/<project-id>`. */
export function leesDsn(dsn) {
  const m = /^https:\/\/([0-9a-f]+)@([a-z0-9.-]+)\/(\d+)$/.exec(String(dsn ?? "").trim());
  if (!m) throw new Error("dit is geen DSN van Sentry (https://<sleutel>@<host>/<project>)");
  return { sleutel: m[1], host: m[2], projectId: m[3] };
}

/**
 * De Sentry-kant, of null zonder sleutel. Een sleutel zonder organisatie is een fout:
 * dan zou de inrichting raden in welke organisatie de projecten komen.
 */
export function sentryUitOmgeving(env, { fetchFn = fetch } = {}) {
  const token = env.SENTRY_AUTH_TOKEN?.trim();
  if (!token) return null;
  const org = env.SENTRY_ORG?.trim();
  if (!org) {
    throw new Error(
      "SENTRY_AUTH_TOKEN staat in de omgeving beheer, maar SENTRY_ORG (de slug van de organisatie in Sentry) ontbreekt",
    );
  }
  return sentryClient({
    fetchFn,
    token,
    org,
    team: env.SENTRY_TEAM?.trim() || undefined,
    url: env.SENTRY_URL?.trim() || undefined,
  });
}

export function sentryClient({ fetchFn = fetch, token, org, team, url = SENTRY_URL }) {
  if (!token) throw new Error("SENTRY_AUTH_TOKEN ontbreekt");
  if (!SLUG.test(org ?? ""))
    throw new Error(`SENTRY_ORG "${org}" is geen slug van een organisatie`);
  if (team !== undefined && !SLUG.test(team))
    throw new Error(`SENTRY_TEAM "${team}" is geen slug van een team`);
  const basis = `${String(url).replace(/\/+$/, "")}/api/0`;
  const api = (pad, opties) => vraag(fetchFn, `${basis}${pad}`, { token, ...opties });
  return {
    org,
    async projecten() {
      return (await api(`/organizations/${org}/projects/?per_page=100`)) ?? [];
    },
    /** Het team voor een nieuw project: SENTRY_TEAM, of het enige team van de organisatie. */
    async kiesTeam() {
      if (team) return team;
      const teams = (await api(`/organizations/${org}/teams/`)) ?? [];
      if (teams.length === 1) return teams[0].slug;
      throw new Error(
        teams.length === 0
          ? `de organisatie ${org} in Sentry heeft geen team; maak er een (Settings, Teams)`
          : `de organisatie ${org} in Sentry heeft meer teams (${teams.map((t) => t.slug).join(", ")}); zet SENTRY_TEAM in de omgeving beheer`,
      );
    },
    maakProject: (teamSlug, naam) =>
      api(`/teams/${org}/${teamSlug}/projects/`, {
        methode: "POST",
        body: { name: naam, slug: naam, platform: "javascript-react" },
      }),
    async sleutels(slug) {
      return (await api(`/projects/${org}/${slug}/keys/`)) ?? [];
    },
    /** Is deze melding in Sentry aangekomen? Tot dan geeft Sentry 404. */
    async gebeurtenisBestaat(slug, eventId) {
      try {
        await api(`/projects/${org}/${slug}/events/${eventId}/`);
        return true;
      } catch (fout) {
        if (fout.status === 404) return false;
        throw fout;
      }
    },
    /**
     * Eén proefmelding rechtstreeks naar de DSN (de envelope-route van Sentry), zoals de
     * app dat zelf doet. Alleen de openbare sleutel uit de DSN gaat mee.
     */
    async stuurProef(dsn, { eventId, bericht }) {
      const { sleutel, host, projectId } = leesDsn(dsn);
      const event = {
        event_id: eventId,
        timestamp: Date.now() / 1000,
        platform: "javascript",
        level: "info",
        environment: "proef",
        message: { formatted: bericht },
        tags: { bron: "stagetwo-beheer" },
      };
      const envelope = `${JSON.stringify({ event_id: eventId, dsn })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}\n`;
      const antwoord = await fetchFn(`https://${host}/api/${projectId}/envelope/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-sentry-envelope",
          "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${sleutel}, sentry_client=stagetwo-beheer/1`,
        },
        body: envelope,
      });
      if (!antwoord.ok) throw new Error(`de proefmelding naar Sentry gaf ${antwoord.status}`);
    },
  };
}

/** De DSN van een project: de eerste actieve sleutel. */
export function dsnVan(sleutels) {
  const k = sleutels.find((s) => s.isActive !== false && s.dsn?.public) ?? null;
  return k?.dsn.public ?? null;
}

/**
 * Stuurt een proefmelding en wacht tot hij in Sentry staat. Geeft `{ aangekomen, eventId }`;
 * nooit een fout om alleen het wachten (Sentry verwerkt soms traag).
 */
export async function proefMelding(
  sentry,
  {
    dsn,
    slug,
    bericht,
    slaap = wacht,
    pogingen = 12,
    wachtMs = 10_000,
    eventId = randomBytes(16).toString("hex"),
  },
) {
  await sentry.stuurProef(dsn, { eventId, bericht });
  for (let poging = 1; poging <= pogingen; poging += 1) {
    if (await sentry.gebeurtenisBestaat(slug, eventId)) return { aangekomen: true, eventId };
    if (poging < pogingen) await slaap(wachtMs);
  }
  return { aangekomen: false, eventId };
}

/**
 * Het project van deze app: het Sentry-project met de naam van de app. Bestaat het niet,
 * dan maakt dit het aan (niet bij `droog`). Een DSN die er al staat (`huidig`), blijft:
 * dit vult alleen aan wat ontbreekt. Na een nieuwe DSN volgt de proefmelding.
 *
 * Geeft `{ dsn, nieuw, actie, waarschuwing? }`: zet de aanroeper `dsn` als `nieuw` waar is,
 * dan komt hij in de GitHub-variabelen van de app.
 */
export async function koppelSentry(
  sentry,
  { app, huidig, droog = false, slaap, pogingen, wachtMs },
) {
  if (!SLUG.test(app)) throw new Error(`"${app}" kan geen naam van een Sentry-project zijn`);
  const projecten = await sentry.projecten();
  let project = projecten.find((p) => p.slug === app) ?? null;
  if (huidig) {
    const passend =
      project && (await sentry.sleutels(project.slug)).some((k) => k.dsn?.public === huidig);
    return {
      dsn: huidig,
      nieuw: false,
      actie: passend
        ? `staat aan (project ${app} in ${sentry.org})`
        : `staat aan met een DSN die er al stond; ongewijzigd${project ? "" : ` (geen project ${app} in ${sentry.org})`}`,
    };
  }
  if (droog) {
    return {
      dsn: null,
      nieuw: false,
      actie: project
        ? `gepland: DSN van project ${app} in production en preview, met een proefmelding`
        : `gepland: Sentry-project ${app} in ${sentry.org} aanmaken, de DSN in production en preview, met een proefmelding`,
    };
  }
  let aangemaakt = false;
  if (!project) {
    project = await sentry.maakProject(await sentry.kiesTeam(), app);
    aangemaakt = true;
  }
  const dsn = dsnVan(await sentry.sleutels(project.slug));
  if (!dsn)
    throw new Error(`het Sentry-project ${project.slug} heeft geen actieve sleutel (Client Keys)`);
  const proef = await proefMelding(sentry, {
    dsn,
    slug: project.slug,
    bericht: `Proefmelding van Stage Two: de foutbewaking van ${app} werkt (App inrichten)`,
    slaap,
    pogingen,
    wachtMs,
  });
  const voor = aangemaakt
    ? `project ${project.slug} aangemaakt in ${sentry.org}`
    : `project ${project.slug} gevonden`;
  return {
    dsn,
    nieuw: true,
    actie: `${voor}, DSN gezet; proefmelding ${proef.aangekomen ? "aangekomen" : "niet aangekomen"}`,
    ...(proef.aangekomen
      ? {}
      : {
          waarschuwing: `de proefmelding naar Sentry-project ${project.slug} is na het wachten niet aangekomen; kijk in Sentry (Issues, omgeving proef) of hij er later staat, en anders of de DSN klopt`,
        }),
  };
}
