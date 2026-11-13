/**
 * De Supabase-kant van de inrichting: het project (Management API) en de custom
 * OIDC-provider `custom:cloudflare` (via supabase-js admin, met de service role).
 *
 * Wat hier bewust niet gebeurt:
 *   - `disable_signup` aanraken. Die moet uit blijven, anders krijgt zelfs een
 *     toegelaten gebruiker bij zijn eerste login geen account. De poort is de
 *     Access-policy op de SaaS-app (KTD5).
 *   - Edge Functions of hun instellingen aanraken.
 *
 * Veldnamen met `NAGAAN (U7)` komen uit één bron of zijn nog niet tegen de echte API
 * getest.
 */
import { createClient } from "@supabase/supabase-js";
import { vraag, wacht } from "./vraag.mjs";

export const SUPABASE_API = "https://api.supabase.com/v1";
export const REGIO = "eu-central-1";
export const PROVIDER = "custom:cloudflare";

export function supabaseUrl(ref) {
  return `https://${ref}.supabase.co`;
}

/** Het adres waar de inlogdienst naar terugstuurt: de enige redirect van de SaaS-app. */
export function callbackAdres(ref) {
  return `${supabaseUrl(ref)}/auth/v1/callback`;
}

/**
 * De adressen waar Supabase na het inloggen naar terug mag. Het account-subdomein komt
 * uit de API en is nooit een wildcard: `https://pr-*-app.*.workers.dev` zou elke Worker
 * van elk account toelaten, en daarmee een token naar een vreemde site sturen.
 *
 * `hostname` is het eigen domein, of in de tijdelijke stand van wrangler.jsonc het
 * workers.dev-adres van de Worker (`<worker>.<subdomein>.workers.dev`). Daarnaast de
 * previews: per PR (`pr-<nummer>-<worker>`) en het vaste adres (`actueel-<worker>`).
 */
export function uriAllowList({ hostname, worker, subdomein }) {
  if (!subdomein || !/^[a-z0-9-]+$/i.test(subdomein)) {
    throw new Error(
      `het workers.dev-subdomein "${subdomein}" is ongeldig; een wildcard mag daar nooit staan`,
    );
  }
  if (!/^[a-z0-9-]+$/.test(worker ?? "")) throw new Error(`de Worker-naam "${worker}" is ongeldig`);
  return [
    `https://${hostname}/**`,
    `https://pr-*-${worker}.${subdomein}.workers.dev/**`,
    // Het vaste preview-adres (label `actueel`, zie Preview uitrollen).
    `https://actueel-${worker}.${subdomein}.workers.dev/**`,
  ];
}

/**
 * De auth-instellingen voor productie. NAGAAN (U7): `uri_allow_list` is in de
 * Management API één tekst met komma's, geen lijst.
 */
export function authInstellingen({ hostname, worker, subdomein }) {
  return {
    site_url: `https://${hostname}`,
    uri_allow_list: uriAllowList({ hostname, worker, subdomein }).join(","),
    external_email_enabled: false,
    // Cloudflare Access geeft een adres pas door na controle (mailcode of de IdP van de
    // klant), maar zet geen email_verified in het id_token. Zonder autoconfirm weigert
    // Supabase dan de inlog ("Unverified email with custom:cloudflare") en koppelt het de
    // inlog niet aan een bestaande gebruiker met hetzelfde adres. email_verified via
    // attribute_mapping kan niet ("protected system field"). Veilig, omdat inloggen met
    // mail en wachtwoord hierboven uit staat. Gevonden bij de doorsteek, 29-09-2026.
    // In de testdatabase staat e-mail wel aan, maar alleen samen met een aanmeld-hook die
    // naar de provider kijkt (aanmeldHookSql in toegang.mjs).
    mailer_autoconfirm: true,
  };
}

/** Mail van een klantportaal gaat via Resend, over SMTP (standaardkeuze 8 van uitgave 43). */
export const SMTP_HOST = "smtp.resend.com";
/** Poort 465: versleuteld vanaf de eerste byte. De gebruikersnaam is bij Resend altijd `resend`. */
export const SMTP_POORT = "465";
export const SMTP_GEBRUIKER = "resend";

/** De inlogcode: zes cijfers, een kwartier geldig (standaardkeuze 9). */
export const CODE_LENGTE = 6;
export const CODE_GELDIG_SECONDEN = 15 * 60;

/**
 * De rem op een open inlogformulier. De eenheden komen uit de broncode van Supabase Auth
 * (internal/api/apilimiter en internal/conf), nagelezen op 13-11-2026:
 *
 *   rate_limit_email_sent  mails per uur, voor het hele project samen. 100: ruim voor een
 *                          drukke ochtend (een klant logt zelden opnieuw in, een sessie
 *                          blijft staan), en een mailbom kost hoogstens 2400 mails per dag.
 *                          Is de grens bereikt, dan krijgt dat uur niemand meer een mail;
 *                          daarvoor is de schakelaar `captcha`.
 *   smtp_max_frequency     seconden tussen twee mails naar hetzelfde adres. 60: één adres
 *                          krijgt hoogstens één mail per minuut.
 *   rate_limit_otp         aanvragen (code, aanmelding, opnieuw sturen) per vijf minuten per
 *                          IP-adres. 15: één mens heeft er één of twee nodig, een kantoor
 *                          achter één adres kan ermee vooruit.
 *   rate_limit_verify      pogingen om een code of link in te wisselen, per vijf minuten per
 *                          IP-adres. 15: in het kwartier dat een code geldt zijn dat 45
 *                          gokken per IP-adres op een miljoen mogelijkheden.
 */
export const REM = {
  rate_limit_email_sent: 100,
  smtp_max_frequency: 60,
  rate_limit_otp: 15,
  rate_limit_verify: 15,
};

function htmlTekst(tekst) {
  return String(tekst)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * De inlogmail: de code én de link in dezelfde mail. Een link uit WhatsApp of Gmail opent
 * vaak in een ingebouwde browser, waar de sessie daarna niet in de echte browser staat; de
 * code werkt altijd. `{{ .Token }}` en `{{ .ConfirmationURL }}` vult Supabase Auth in. De
 * naam komt uit toegang.json en mag geen HTML of sjabloonopdracht kunnen worden: het
 * patroon van de afzender laat dat niet toe, en hier wordt hij nog eens als tekst gezet.
 */
export function inlogmail(naam) {
  if (/[{}<>]/.test(naam)) throw new Error("de naam van de afzender bevat een ongeldig teken");
  const n = htmlTekst(naam);
  const minuten = CODE_GELDIG_SECONDEN / 60;
  return {
    onderwerp: `Inloggen bij ${naam}`,
    metCode: [
      `<h2>Inloggen bij ${n}</h2>`,
      "<p>Vul deze code in op het inlogscherm:</p>",
      '<p style="font-size: 28px; letter-spacing: 4px;"><strong>{{ .Token }}</strong></p>',
      "<p>Of klik op de link om meteen in te loggen:</p>",
      `<p><a href="{{ .ConfirmationURL }}">Inloggen bij ${n}</a></p>`,
      `<p>De code en de link zijn ${minuten} minuten geldig en werken één keer. Heb je dit niet aangevraagd, dan hoef je niets te doen.</p>`,
    ].join("\n"),
    // Voor de herstelmail (iemand roept /recover aan): alleen een link. De code uit zo'n
    // mail is van een ander soort en werkt niet in het codevak van de app.
    alleenLink: [
      `<h2>Inloggen bij ${n}</h2>`,
      `<p><a href="{{ .ConfirmationURL }}">Inloggen bij ${n}</a></p>`,
      `<p>De link is ${minuten} minuten geldig en werkt één keer. Heb je dit niet aangevraagd, dan hoef je niets te doen.</p>`,
    ].join("\n"),
  };
}

/**
 * De auth-instellingen van een klantportaal, alleen voor productie; ze komen bovenop
 * authInstellingen. Veldnamen nagelopen tegen de Management API (UpdateAuthConfigBody in
 * https://api.supabase.com/api/v1-json, 13-11-2026).
 *
 * `mailer_autoconfirm` gaat hier UIT. Bij een gewone app staat hij aan omdat Cloudflare geen
 * email_verified meestuurt (zie authInstellingen), en dat is daar veilig omdat inloggen met
 * e-mail uit staat. Hier staat e-mail aan. Met autoconfirm aan zou iedereen via /signup met
 * een zelfgekozen wachtwoord een account op andermans adres kunnen maken en meteen een
 * sessie krijgen, zonder ooit de mailbox te zien; logt de echte klant later in en keurt het
 * bedrijf hem goed, dan zit de ander al binnen. Met autoconfirm uit moet elk adres eerst
 * bewezen worden met de link of de code uit de mail.
 *
 * De prijs, uit de broncode van Supabase Auth (internal/api/external.go en
 * internal/models/linking.go), niet tegen een echt project getest:
 *   - een medewerker die al een account had (van vóór het klantportaal) merkt niets;
 *   - een nieuwe medewerker krijgt bij zijn eerste inlog via Cloudflare één keer de melding
 *     dat zijn adres nog bevestigd moet worden, met een mail; daarna werkt het;
 *   - een medewerker die eerst per mail een klantaccount op zijn werkadres maakte, krijgt
 *     via Cloudflare een tweede account zonder adres dat niet te bevestigen is. Toegang
 *     bijwerken meldt zulke accounts (zie trekIn); de README zegt wat de owner dan doet.
 *
 * `mailer_allow_unverified_email_sign_ins` blijft uit: dat is de andere schakelaar waarmee
 * een onbevestigd adres toch kan inloggen. `disable_signup` blijft onaangeroerd.
 *
 * `smtpWachtwoord` en `captchaGeheim` zijn geheimen. Ze staan alleen in de body van de PATCH
 * en nooit in een melding of in het resultaat.
 */
export function klantportaalInstellingen({ afzender, smtpWachtwoord, captcha, captchaGeheim }) {
  if (!afzender?.adres || !afzender?.naam)
    throw new Error("de afzender van de inlogmail ontbreekt");
  if (!smtpWachtwoord) throw new Error("SMTP_WACHTWOORD ontbreekt");
  if (captcha && !captchaGeheim) throw new Error("TURNSTILE_GEHEIM ontbreekt");
  const mail = inlogmail(afzender.naam);
  return {
    external_email_enabled: true,
    mailer_autoconfirm: false,
    mailer_allow_unverified_email_sign_ins: false,
    // Zelf een inlog aan een account hangen of ervan afhalen blijft uit. Anders kan een
    // medewerker zijn Cloudflare-inlog loskoppelen, als "klant" verder gaan met dezelfde
    // sessie, en bij zijn vertrek aan Toegang bijwerken ontsnappen.
    security_manual_linking_enabled: false,
    smtp_host: SMTP_HOST,
    smtp_port: SMTP_POORT,
    smtp_user: SMTP_GEBRUIKER,
    smtp_pass: smtpWachtwoord,
    smtp_admin_email: afzender.adres,
    smtp_sender_name: afzender.naam,
    mailer_otp_length: CODE_LENGTE,
    mailer_otp_exp: CODE_GELDIG_SECONDEN,
    // Een nieuw adres krijgt het sjabloon "confirmation", een bekend adres "magic_link"
    // (internal/api/magic_link.go). Allebei dezelfde mail, anders ziet een nieuwe klant
    // de Engelse standaardtekst zonder code.
    mailer_subjects_confirmation: mail.onderwerp,
    mailer_templates_confirmation_content: mail.metCode,
    mailer_subjects_magic_link: mail.onderwerp,
    mailer_templates_magic_link_content: mail.metCode,
    mailer_subjects_recovery: mail.onderwerp,
    mailer_templates_recovery_content: mail.alleenLink,
    ...REM,
    security_captcha_enabled: Boolean(captcha),
    ...(captcha
      ? { security_captcha_provider: "turnstile", security_captcha_secret: captchaGeheim }
      : {}),
  };
}

/**
 * De before-user-created-hook van de testdatabase. Zet ook inloggen met e-mail aan;
 * schrijf de hookfunctie dus altijd eerst. NAGAAN (U7): de veldnamen
 * `hook_before_user_created_enabled` en `hook_before_user_created_uri` en de vorm
 * `pg-functions://postgres/<schema>/<functie>`.
 */
export function hookInstellingen(functie) {
  return {
    external_email_enabled: true,
    hook_before_user_created_enabled: true,
    hook_before_user_created_uri: `pg-functions://postgres/public/${functie}`,
  };
}

/** Welke velden van `gewenst` in `huidig` anders zijn; leeg = niets te doen. */
export function verschil(huidig, gewenst) {
  const uit = {};
  for (const [k, v] of Object.entries(gewenst)) {
    if (huidig?.[k] !== v) uit[k] = v;
  }
  return uit;
}

/**
 * SUPABASE_ORG_SLUG mag meerdere organisaties noemen, met komma's: `winco,plantas`. Een
 * klant met meer dan één BV houdt zo per BV een eigen organisatie (en rekening), en de
 * beheer-repo vindt de projecten in elk ervan. Een nieuw project komt altijd in de eerste.
 */
export function organisaties(orgSlug) {
  return (orgSlug ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

export function supabaseBeheer({ fetchFn = fetch, token, orgSlug, slaap = wacht }) {
  if (!token) throw new Error("SUPABASE_ACCESS_TOKEN ontbreekt");
  const s = (pad, opties) => vraag(fetchFn, `${SUPABASE_API}${pad}`, { token, ...opties });
  const orgs = organisaties(orgSlug);
  return {
    async projecten() {
      const lijst = (await s("/projects")) ?? [];
      return lijst.filter(
        (p) => p.status !== "REMOVED" && (!orgs.length || orgs.includes(p.organization_slug)),
      );
    },
    maakProject(naam, wachtwoord) {
      if (!orgs.length) throw new Error("SUPABASE_ORG_SLUG ontbreekt");
      return s("/projects", {
        methode: "POST",
        body: { name: naam, organization_slug: orgs[0], db_pass: wachtwoord, region: REGIO },
      });
    },
    /** Wacht tot het project gezond is; een nieuw project heeft daar een paar minuten voor nodig. */
    async wachtTotGezond(ref, { pogingen = 40, wachtMs = 15000 } = {}) {
      for (let i = 0; i < pogingen; i += 1) {
        const p = await s(`/projects/${ref}`);
        if (p.status === "ACTIVE_HEALTHY") return p;
        if (["INIT_FAILED", "REMOVED", "RESTORE_FAILED"].includes(p.status)) {
          throw new Error(`Supabase-project ${ref} kwam niet goed op (status ${p.status})`);
        }
        await slaap(wachtMs);
      }
      throw new Error(
        `Supabase-project ${ref} is na tien minuten nog niet gezond; kijk in het Supabase-dashboard`,
      );
    },
    /**
     * De anon key (publiek, voor de browser), de service role (alleen hier, nooit in de
     * app) en, als het project die heeft, de publishable key (sb_publishable_...). Die
     * laatste is ook publiek, maar ziet er niet uit als een JWT; guard:secrets laat
     * hem daarom in git staan (stack.config.json), de anon-JWT niet.
     */
    async sleutels(ref) {
      const lijst = (await s(`/projects/${ref}/api-keys?reveal=true`)) ?? [];
      const anon =
        lijst.find((k) => k.name === "anon") ?? lijst.find((k) => k.type === "publishable");
      const service =
        lijst.find((k) => k.name === "service_role") ?? lijst.find((k) => k.type === "secret");
      if (!anon?.api_key || !service?.api_key) {
        throw new Error(`de sleutels van Supabase-project ${ref} zijn niet volledig op te halen`);
      }
      const publishable = lijst.find((k) => k.type === "publishable")?.api_key ?? null;
      return { anon: anon.api_key, serviceRole: service.api_key, publishable };
    },
    /**
     * Het adres van de session pooler (IPv4). De directe databasehost is alleen via IPv6
     * bereikbaar, en de runners van GitHub hebben geen IPv6; deploy-db.yml migreert dus
     * via deze host. NAGAAN (U7): veldnaam db_host en database_type PRIMARY.
     */
    async poolerHost(ref) {
      const lijst = (await s(`/projects/${ref}/config/database/pooler`)) ?? [];
      const primair = lijst.find((p) => p.database_type === "PRIMARY") ?? lijst[0];
      return typeof primair?.db_host === "string" && primair.db_host ? primair.db_host : null;
    },
    /** Een nieuw databasewachtwoord; het oude werkt daarna niet meer. */
    zetDatabaseWachtwoord: (ref, wachtwoord) =>
      s(`/projects/${ref}/database/password`, { methode: "PATCH", body: { password: wachtwoord } }),
    authConfig: (ref) => s(`/projects/${ref}/config/auth`),
    werkAuthBij: (ref, velden) =>
      s(`/projects/${ref}/config/auth`, { methode: "PATCH", body: velden }),
    voerSqlUit: (ref, query) =>
      s(`/projects/${ref}/database/query`, { methode: "POST", body: { query } }),
    verwijderProject: (ref) => s(`/projects/${ref}`, { methode: "DELETE" }),
  };
}

/** Standaard: een supabase-js admin-client met de service role, zonder sessie. */
export function standaardAdmin(url, serviceRole) {
  return createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).auth.admin;
}

function eisGeenFout(resultaat, actie) {
  if (resultaat?.error)
    throw new Error(`Supabase ${actie}: ${resultaat.error.message ?? resultaat.error}`);
  return resultaat?.data;
}

/**
 * Zet de custom provider `custom:cloudflare` zoals hij hoort, idempotent via de lijst.
 * Het client_secret van de SaaS-app is alleen bij het aanmaken te zien; ontbreekt het
 * en bestaat de provider nog niet, dan kan dit niet en zegt het script wat te doen.
 * NAGAAN (U7): of `identifier` het voorvoegsel `custom:` zelf moet bevatten.
 */
export async function zetProvider(providers, { issuer, clientId, clientSecret }) {
  const lijst = eisGeenFout(await providers.listProviders(), "listProviders")?.providers ?? [];
  const bestaand = lijst.find((p) => p.identifier === PROVIDER);
  if (!bestaand) {
    if (!clientSecret) {
      throw new Error(
        "de SaaS-app bestaat al maar de provider in Supabase niet, en het client_secret is alleen bij het aanmaken te zien. Ruim op met --opruimen en draai de inrichting opnieuw.",
      );
    }
    eisGeenFout(
      await providers.createProvider({
        provider_type: "oidc",
        identifier: PROVIDER,
        name: "Cloudflare Access",
        client_id: clientId,
        client_secret: clientSecret,
        issuer,
        pkce_enabled: true,
        scopes: ["openid", "email", "profile"],
        enabled: true,
      }),
      "createProvider",
    );
    return "aangemaakt";
  }
  const zelfde =
    bestaand.issuer === issuer &&
    bestaand.client_id === clientId &&
    bestaand.pkce_enabled !== false;
  if (zelfde && !clientSecret) return "ongewijzigd";
  eisGeenFout(
    await providers.updateProvider(PROVIDER, {
      issuer,
      client_id: clientId,
      pkce_enabled: true,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    }),
    "updateProvider",
  );
  return "bijgewerkt";
}

export async function verwijderProvider(providers) {
  const lijst = eisGeenFout(await providers.listProviders(), "listProviders")?.providers ?? [];
  if (!lijst.some((p) => p.identifier === PROVIDER)) return false;
  eisGeenFout(await providers.deleteProvider(PROVIDER), "deleteProvider");
  return true;
}

/** Alle gebruikers van een project, pagina voor pagina. */
export async function alleGebruikers(admin, { perPagina = 1000 } = {}) {
  const alles = [];
  for (let pagina = 1; ; pagina += 1) {
    const data = eisGeenFout(
      await admin.listUsers({ page: pagina, perPage: perPagina }),
      "listUsers",
    );
    const users = data?.users ?? [];
    alles.push(...users);
    if (users.length < perPagina) return alles;
  }
}

/**
 * Alle sessies van een gebruiker beëindigen. De admin-API van supabase-js kan alleen
 * afmelden met het token van de gebruiker zelf; daarom gaat dit via SQL op
 * `auth.sessions`, waarna de refresh-tokens van die sessies niet meer werken.
 * NAGAAN (U7): dat het verwijderen van de sessie de refresh-tokens meeneemt.
 */
export function afmeldSql(userId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    throw new Error(`"${userId}" is geen geldige gebruikers-id`);
  }
  return `delete from auth.sessions where user_id = '${userId}'::uuid;`;
}
