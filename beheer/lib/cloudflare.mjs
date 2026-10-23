/**
 * De Cloudflare-kant van de inrichting: herbruikbare Access-policies, de Access-apps
 * (deur, inlogdienst en de Worker zelf) en een paar gegevens van het account.
 *
 * Alles wat dit script maakt heeft een naam die begint met het voorvoegsel (een
 * verplichte instelling: `cf-proef-` voor de proef, `rp-` voor Richplant). Daaraan
 * herkent een volgende run wat van hem is (hergebruiken) en wat niet (afblijven), en
 * daaraan herkent --opruimen wat weg mag. Op hetzelfde account kunnen ook andere apps
 * draaien; alles zonder dit voorvoegsel is van iemand anders.
 *
 * Veldnamen van de API: waar een naam uit maar één bron komt of nog niet tegen de
 * echte API is getest, staat `NAGAAN (U7)` erbij. De live doorsteek (U7) bevestigt ze.
 */
import { vraag, wacht } from "./vraag.mjs";

/** Het voorvoegsel van de proef; alleen de proef mag terugvallen op de eigen repo. */
export const PROEF_VOORVOEGSEL = "cf-proef-";
export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const PER_PAGINA = 100;

/**
 * Een voorvoegsel is een kleine letter, dan hoogstens vijftien kleine letters of cijfers,
 * en precies één streepje, aan het eind (bijvoorbeeld `rp-`). De enige uitzondering is
 * het voorvoegsel van de proef, `cf-proef-`; `cf-` zelf en elk ander voorvoegsel met
 * `cf-` ervoor is geweigerd.
 *
 * Daardoor kan geen geldig voorvoegsel met een ander geldig voorvoegsel beginnen: wat
 * met `rp-` begint is van `rp-` en van niemand anders (een `rp-x-` bestaat niet). Het
 * eigendom op het gedeelde account hangt aan die garantie. Ook de hookfunctie die ervan
 * afgeleid wordt (streepjes worden liggende streepjes) is daardoor altijd veilig in SQL.
 */
const VOORVOEGSEL_PATROON = /^[a-z][a-z0-9]{0,15}-$/;

function geldigVoorvoegsel(voorvoegsel) {
  if (voorvoegsel === PROEF_VOORVOEGSEL) return true;
  return VOORVOEGSEL_PATROON.test(voorvoegsel) && voorvoegsel !== "cf-";
}

export function valideerVoorvoegsel(voorvoegsel) {
  if (voorvoegsel === undefined || voorvoegsel === null || voorvoegsel === "") {
    throw new Error(
      "het voorvoegsel ontbreekt: geef --voorvoegsel <voorvoegsel> mee of zet BEHEER_VOORVOEGSEL (proef: cf-proef-, Richplant: rp-). Alles wat het script aanmaakt, hergebruikt of opruimt hangt eraan.",
    );
  }
  if (typeof voorvoegsel !== "string" || !geldigVoorvoegsel(voorvoegsel)) {
    throw new Error(
      `het voorvoegsel "${voorvoegsel}" is ongeldig: een kleine letter, dan hoogstens vijftien kleine letters of cijfers, en één streepje aan het eind (bijvoorbeeld rp-); ${PROEF_VOORVOEGSEL} is de enige uitzondering en cf- is voor de proef gereserveerd`,
    );
  }
  return voorvoegsel;
}

/** De namen van alles wat bij één app hoort. */
export function appNamen(app, voorvoegsel) {
  const vv = valideerVoorvoegsel(voorvoegsel);
  return {
    deur: `${vv}${app}`,
    inlog: `${vv}${app}-inlog`,
    worker: `${vv}${app}-worker`,
    project: `${vv}${app}`,
    // De testdatabase: een tweede Supabase-project met een eigen inlog-app, zodat de
    // previews nooit bij productie kunnen.
    test: `${vv}${app}-test`,
    testInlog: `${vv}${app}-test-inlog`,
  };
}

/** "stagetwo", "stagetwo.cloudflareaccess.com" of een volledige URL: altijd de host. */
export function normaliseerTeamDomein(waarde) {
  const kaal = String(waarde ?? "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  if (!kaal) return null;
  const host = kaal.includes(".") ? kaal : `${kaal}.cloudflareaccess.com`;
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(host)) {
    throw new Error(`CLOUDFLARE_TEAM_DOMAIN "${waarde}" is geen <team>.cloudflareaccess.com`);
  }
  return host.toLowerCase();
}

/**
 * De issuer van een OIDC-SaaS-app. NAGAAN (U7): het formaat komt uit de documentatie
 * van Access for SaaS (OIDC); de API geeft hem mogelijk ook zelf terug in `saas_app`.
 */
export function issuerVoor(teamDomein, clientId) {
  return `https://${normaliseerTeamDomein(teamDomein)}/cdn-cgi/access/sso/oidc/${clientId}`;
}

/**
 * Wacht tot Cloudflare een net aangemaakte OIDC-SaaS-app ook echt serveert. Direct na
 * het aanmaken geeft het discovery-adres een paar minuten 404 ("Application is not an
 * OIDC application"), en Supabase weigert de provider dan. Gemeten bij de doorsteek
 * (29-09-2026): enkele minuten. Geeft het aantal pogingen terug.
 */
export async function wachtOpDiscovery(
  issuer,
  { fetchFn = fetch, slaap = wacht, pogingen = 36, wachtMs = 10_000 } = {},
) {
  const adres = `${issuer}/.well-known/openid-configuration`;
  let laatste = null;
  for (let poging = 1; poging <= pogingen; poging += 1) {
    try {
      const antwoord = await fetchFn(adres);
      if (antwoord.ok) return poging;
      laatste = antwoord.status;
    } catch (fout) {
      laatste = fout.message;
    }
    if (poging < pogingen) await slaap(wachtMs);
  }
  throw new Error(
    `de OIDC-app is na ${pogingen} pogingen nog niet bereikbaar op ${adres} (laatste antwoord: ${laatste})`,
  );
}

function policyLijst(policyIds) {
  if (!Array.isArray(policyIds) || policyIds.length === 0 || policyIds.some((id) => !id)) {
    throw new Error("een Access-app zonder policies laat niemand toe; er ontbreekt een policy-id");
  }
  return policyIds.map((id, i) => ({ id, precedence: i + 1 }));
}

function inlogmethoden(idps) {
  if (!Array.isArray(idps) || idps.length === 0) {
    throw new Error(
      "de lijst toegestane inlogmethoden (allowed_idps) is leeg; zet er expliciet die van de klant in (proef: one-time PIN)",
    );
  }
  return {
    allowed_idps: [...idps],
    // Eén methode: meteen doorsturen in plaats van een keuzescherm met één knop.
    auto_redirect_to_identity: idps.length === 1,
  };
}

/** De deur: een self-hosted Access-app op het eigen domein van de app. */
export function deurApp({ naam, hostname, policyIds, idps }) {
  return {
    name: naam,
    type: "self_hosted",
    domain: hostname,
    // NAGAAN (U7): `destinations` naast `domain`; nieuwere API-versies gebruiken alleen destinations.
    destinations: [{ type: "public", uri: hostname }],
    app_launcher_visible: false,
    session_duration: "720h", // 30 dagen: ook een app op het beginscherm blijft ingelogd
    ...inlogmethoden(idps),
    policies: policyLijst(policyIds),
  };
}

/**
 * De inlogdienst: een SaaS-app van het type OIDC, met als enige redirect het
 * callback-adres van het Supabase-project.
 *
 * NAGAAN (U7): `grant_types: ["authorization_code"]` met PKCE van de kant van Supabase.
 * Cloudflare kent ook `authorization_code_with_pkce`; als de code-challenge van
 * Supabase geweigerd wordt, is dat de waarde. `allow_pkce_without_client_secret` blijft
 * uit: Supabase is een vertrouwelijke client met een eigen geheim.
 */
export function inlogApp({ naam, callback, policyIds, idps }) {
  return {
    name: naam,
    type: "saas",
    app_launcher_visible: false,
    ...inlogmethoden(idps),
    policies: policyLijst(policyIds),
    saas_app: {
      auth_type: "oidc",
      redirect_uris: [callback],
      grant_types: ["authorization_code"],
      scopes: ["openid", "email", "profile", "groups"],
      allow_pkce_without_client_secret: false,
    },
  };
}

/**
 * Access op de Worker zelf: dekt het workers.dev-adres en alle versie- en
 * preview-adressen (`<alias>-<worker>.<subdomein>.workers.dev`). Dit is wat de knop
 * "Cloudflare Access" bij een Worker in het dashboard aanmaakt. NAGAAN (U7): of een
 * wildcard vooraan in het eerste label als destination wordt geaccepteerd.
 */
export function workerApp({ naam, worker, subdomein, policyIds, idps }) {
  if (!subdomein || subdomein.includes("*")) throw new Error("het workers.dev-subdomein ontbreekt");
  const basis = `${worker}.${subdomein}.workers.dev`;
  return {
    name: naam,
    type: "self_hosted",
    domain: basis,
    destinations: [
      { type: "public", uri: basis },
      { type: "public", uri: `*-${basis}` },
    ],
    app_launcher_visible: false,
    session_duration: "720h", // 30 dagen: ook een app op het beginscherm blijft ingelogd
    ...inlogmethoden(idps),
    policies: policyLijst(policyIds),
  };
}

/** Velden die de API zelf bijhoudt en die niet terug horen in een PUT. */
const ALLEEN_LEZEN = ["id", "uid", "aud", "created_at", "updated_at", "scim_config"];

/**
 * De body voor het bijwerken van een bestaande app met andere policies. NAGAAN (U7):
 * dat een PUT met de gelezen velden (zonder client_secret bij een SaaS-app) het geheim
 * en de client_id ongemoeid laat.
 */
export function metPolicies(app, policyIds) {
  const body = { ...app };
  for (const veld of ALLEEN_LEZEN) delete body[veld];
  if (body.saas_app) {
    body.saas_app = { ...body.saas_app };
    delete body.saas_app.client_secret;
  }
  return { ...body, policies: policyLijst(policyIds) };
}

export function policyIdsVanApp(app) {
  return (app?.policies ?? []).map((p) => (typeof p === "string" ? p : p.id));
}

/**
 * Wat er bij een bestaande app anders is dan gewenst: "policies" en/of "inlogmethoden"
 * (allowed_idps en auto_redirect_to_identity). Leeg betekent niets bijwerken.
 */
export function afwijkingen(app, policyIds, idps) {
  const uit = [];
  if (JSON.stringify(policyIdsVanApp(app)) !== JSON.stringify(policyIds)) uit.push("policies");
  const gewenst = inlogmethoden(idps);
  const huidig = [...(app?.allowed_idps ?? [])].sort();
  if (
    JSON.stringify(huidig) !== JSON.stringify([...gewenst.allowed_idps].sort()) ||
    Boolean(app?.auto_redirect_to_identity) !== gewenst.auto_redirect_to_identity
  ) {
    uit.push("inlogmethoden");
  }
  return uit;
}

/** De body voor een bestaande app met de gewenste policies én inlogmethoden. */
export function metGewenst(app, policyIds, idps) {
  return { ...metPolicies(app, policyIds), ...inlogmethoden(idps) };
}

/**
 * De placeholder-Worker: geeft op elk verzoek 503 "Deze app wordt ingericht." Hij staat
 * er alleen tussen de inrichting en de eerste echte uitrol, zodat de Access op de Worker
 * al bestaat voordat er iets van de app op workers.dev staat. `wrangler deploy`
 * overschrijft hem.
 */
export const PLACEHOLDER_MODULE = `export default {
  fetch() {
    return new Response("Deze app wordt ingericht.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "60" },
    });
  },
};
`;

/**
 * Het multipart-formulier voor het uploaden van de placeholder als ES-module.
 * NAGAAN (U7): de deelnamen `metadata` en `<main_module>`, `main_module` en
 * `compatibility_date` in de metadata, en het type `application/javascript+module`.
 */
export function placeholderFormulier() {
  const form = new FormData();
  form.append(
    "metadata",
    new Blob(
      [JSON.stringify({ main_module: "placeholder.mjs", compatibility_date: "2026-09-01" })],
      {
        type: "application/json",
      },
    ),
  );
  form.append(
    "placeholder.mjs",
    new Blob([PLACEHOLDER_MODULE], { type: "application/javascript+module" }),
    "placeholder.mjs",
  );
  return form;
}

export function cloudflareClient({ fetchFn = fetch, token, accountId, teamDomein }) {
  if (!token) throw new Error("de Cloudflare-sleutel (CLOUDFLARE_PROEF_TOKEN) ontbreekt");
  if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID ontbreekt");
  const basis = `${CLOUDFLARE_API}/accounts/${accountId}`;
  const cf = async (pad, opties) =>
    (await vraag(fetchFn, `${basis}${pad}`, { token, ...opties }))?.result;

  async function lijst(pad) {
    const alles = [];
    for (let pagina = 1; ; pagina += 1) {
      const deel = (await cf(`${pad}?page=${pagina}&per_page=${PER_PAGINA}`)) ?? [];
      alles.push(...deel);
      if (deel.length < PER_PAGINA) return alles;
    }
  }

  return {
    // Herbruikbare policies: /accounts/{id}/access/policies.
    policies: () => lijst("/access/policies"),
    maakPolicy: (body) => cf("/access/policies", { methode: "POST", body }),
    werkPolicyBij: (id, body) => cf(`/access/policies/${id}`, { methode: "PUT", body }),
    verwijderPolicy: (id) => cf(`/access/policies/${id}`, { methode: "DELETE" }),

    apps: () => lijst("/access/apps"),
    maakApp: (body) => cf("/access/apps", { methode: "POST", body }),
    werkAppBij: (id, body) => cf(`/access/apps/${id}`, { methode: "PUT", body }),
    verwijderApp: (id) => cf(`/access/apps/${id}`, { methode: "DELETE" }),

    identiteitsdiensten: () => lijst("/access/identity_providers"),

    /**
     * Het teamdomein. Liefst meegegeven (CLOUDFLARE_TEAM_DOMAIN): een smalle sleutel kan
     * de organisatie niet altijd lezen. NAGAAN (U7): het veld `auth_domain`.
     */
    async teamDomein() {
      if (teamDomein) return normaliseerTeamDomein(teamDomein);
      const org = await cf("/access/organizations");
      const domein = normaliseerTeamDomein(org?.auth_domain);
      if (!domein) throw new Error("het teamdomein is onbekend; zet CLOUDFLARE_TEAM_DOMAIN (P1)");
      return domein;
    },

    /** Het workers.dev-subdomein van het account, bijvoorbeeld `stagetwo` in `x.stagetwo.workers.dev`. */
    async workersSubdomein() {
      const r = await cf("/workers/subdomain");
      const sub = r?.subdomain;
      if (!sub || !/^[a-z0-9-]+$/i.test(sub)) {
        throw new Error(
          "het account heeft geen workers.dev-subdomein; stel het in het dashboard in",
        );
      }
      return sub.toLowerCase();
    },

    /**
     * Bestaat de Worker al (is er al eens uitgerold)? 404 betekent nee. Het antwoord bij
     * 200 is de code van de Worker, geen JSON; daar kijken we niet naar.
     */
    async workerBestaat(naam) {
      try {
        await vraag(fetchFn, `${basis}/workers/scripts/${encodeURIComponent(naam)}`, { token });
        return true;
      } catch (fout) {
        if (fout.status === 404) return false;
        throw fout;
      }
    },

    /**
     * Zet een placeholder-Worker neer (503, zie PLACEHOLDER_MODULE) en zet zijn
     * workers.dev-adres en de preview-adressen aan, zodat de Access op de Worker er al
     * staat vóór de eerste uitrol. NAGAAN (U7): PUT /workers/scripts/{naam} met
     * multipart, en POST /workers/scripts/{naam}/subdomain met `enabled` en
     * `previews_enabled`.
     */
    async maakPlaceholder(naam) {
      const pad = `/workers/scripts/${encodeURIComponent(naam)}`;
      await cf(pad, { methode: "PUT", body: placeholderFormulier() });
      await cf(`${pad}/subdomain`, {
        methode: "POST",
        body: { enabled: true, previews_enabled: true },
      });
    },

    /**
     * Verwijdert het Worker-script. Geeft false als hij er niet was (404).
     * NAGAAN (U7): DELETE /workers/scripts/{naam}, zonder `force`.
     */
    async verwijderWorker(naam) {
      try {
        await cf(`/workers/scripts/${encodeURIComponent(naam)}`, { methode: "DELETE" });
        return true;
      } catch (fout) {
        if (fout.status === 404) return false;
        throw fout;
      }
    },
  };
}
