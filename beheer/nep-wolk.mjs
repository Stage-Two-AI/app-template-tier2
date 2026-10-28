/**
 * Een nagebootste Cloudflare-, Supabase- en GitHub-kant voor de tests van beheer/.
 *
 * Alles wat het inrichtingsscript naar buiten doet komt hier langs: `fetchFn` voor de
 * API's van Cloudflare en Supabase, `maakAdmin` voor supabase-js (custom providers en
 * gebruikers) en `gh` voor de GitHub-CLI. Elke aanroep komt in `aanroepen`, zodat een
 * test de volgorde en het aantal schrijfacties kan nalopen. De wolk onthoudt wat er is
 * aangemaakt, zodat een tweede run echt tegen "alles bestaat al" aan loopt.
 *
 * Dit is geen testbestand zelf (geen `.test.` in de naam); `node --test beheer/` slaat
 * het over.
 */

const CF = "api.cloudflare.com/client/v4/accounts/acc";
const SB = "api.supabase.com/v1";

function antwoord(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? "Not Found" : status >= 400 ? "Fout" : "OK",
    text: async () => (data === undefined ? "" : JSON.stringify(data)),
  };
}

const cfOk = (result) => antwoord(200, { success: true, errors: [], result });
const cfFout = (status, message) =>
  antwoord(status, { success: false, errors: [{ code: 10000, message }], result: null });

export function nepWolk({
  workerBestaat = false,
  idps = [{ id: "idp-otp", type: "onetimepin", name: "One-time PIN" }],
  subdomein = "stagetwo-acc",
  policies = [],
  apps = [],
  projecten = [],
  gebruikers = [],
  providers = [],
  ghVariabelen = {},
  ghSecrets = {},
  faal = () => null,
  poolerFout = null,
} = {}) {
  const staat = {
    // Wordt true na een PUT van het script (de placeholder) en false na een DELETE.
    workerBestaat,
    policies: policies.map((p) => ({ ...p })),
    apps: apps.map((a) => ({ ...a })),
    projecten: projecten.map((p) => ({ ...p })),
    auth: {},
    sql: [],
    // Dezelfde SQL, maar met het project erbij: { ref, query }.
    sqlOp: [],
    providers: providers.map((p) => ({ ...p })),
    gebruikers: gebruikers.map((g) => ({ ...g })),
    // Eigen gebruikers per project, op de url van supabase-js (`https://<ref>.supabase.co`).
    // Zonder eigen lijst delen de projecten `gebruikers`.
    gebruikersOp: {},
    ghVariabelen: structuredClone(ghVariabelen),
    // Secret-namen per omgeving; "repo" voor secrets op de repo zelf.
    ghSecrets: structuredClone(ghSecrets),
    teller: 0,
    // Een HTTP-status: dan faalt de pooler-endpoint met die status (bijvoorbeeld 500).
    poolerFout,
  };
  const aanroepen = [];
  const nieuwId = (soort) => `${soort}-${++staat.teller}`;

  async function fetchFn(url, opties = {}) {
    const u = new URL(url);
    const methode = opties.method ?? "GET";
    // Een FormData (multipart, het Worker-script) blijft zoals hij is.
    const body =
      opties.body instanceof FormData
        ? opties.body
        : opties.body
          ? JSON.parse(opties.body)
          : undefined;
    const pad = `${u.host}${u.pathname}`;
    aanroepen.push({ soort: "fetch", methode, pad, url, body, headers: opties.headers });

    const fout = faal(methode, pad, body);
    if (fout)
      return pad.startsWith(CF)
        ? cfFout(fout.status, fout.message)
        : antwoord(fout.status, { message: fout.message });

    if (pad.startsWith(CF)) {
      const rest = pad.slice(CF.length);
      let m = null;
      const pas = (re) => {
        m = rest.match(re);
        return m;
      };
      if (rest === "/access/policies" && methode === "GET") return cfOk(staat.policies);
      if (rest === "/access/policies" && methode === "POST") {
        const p = { id: nieuwId("pol"), ...body };
        staat.policies.push(p);
        return cfOk(p);
      }
      if (pas(/^\/access\/policies\/([^/]+)$/)) {
        const i = staat.policies.findIndex((p) => p.id === m[1]);
        if (i === -1) return cfFout(404, "policy bestaat niet");
        if (methode === "PUT") {
          staat.policies[i] = { id: m[1], ...body };
          return cfOk(staat.policies[i]);
        }
        if (methode === "DELETE") {
          const inGebruik = staat.apps.some((a) => (a.policies ?? []).some((q) => q.id === m[1]));
          if (inGebruik) return cfFout(400, "policy is nog aan een app gekoppeld");
          staat.policies.splice(i, 1);
          return cfOk({ id: m[1] });
        }
      }
      if (rest === "/access/apps" && methode === "GET") return cfOk(staat.apps);
      if (rest === "/access/apps" && methode === "POST") {
        const a = { id: nieuwId("app"), aud: "aud", ...body };
        if (body.type === "saas") {
          const n = staat.teller;
          a.saas_app = { ...body.saas_app, client_id: `cid-${n}`, client_secret: `geheim-cs-${n}` };
        }
        staat.apps.push(a);
        // De echte API geeft het client_secret alleen bij het aanmaken terug.
        const bewaard = structuredClone(a);
        if (bewaard.saas_app) delete bewaard.saas_app.client_secret;
        staat.apps[staat.apps.length - 1] = bewaard;
        return cfOk(a);
      }
      if (pas(/^\/access\/apps\/([^/]+)$/)) {
        const i = staat.apps.findIndex((a) => a.id === m[1]);
        if (i === -1) return cfFout(404, "app bestaat niet");
        if (methode === "PUT") {
          staat.apps[i] = { ...staat.apps[i], ...body, id: m[1] };
          return cfOk(staat.apps[i]);
        }
        if (methode === "DELETE") {
          staat.apps.splice(i, 1);
          return cfOk({ id: m[1] });
        }
      }
      if (rest === "/access/identity_providers" && methode === "GET") return cfOk(idps);
      if (rest === "/access/organizations" && methode === "GET")
        return cfOk({ auth_domain: "stagetwo.cloudflareaccess.com" });
      if (rest === "/workers/subdomain" && methode === "GET") return cfOk({ subdomain: subdomein });
      if (pas(/^\/workers\/scripts\/([^/]+)$/)) {
        if (methode === "GET")
          return staat.workerBestaat
            ? antwoord(200, undefined)
            : cfFout(404, "script bestaat niet");
        if (methode === "PUT") {
          if (!(body instanceof FormData)) return cfFout(400, "script verwacht multipart");
          staat.workerBestaat = true;
          return cfOk({ id: m[1] });
        }
        if (methode === "DELETE") {
          if (!staat.workerBestaat) return cfFout(404, "script bestaat niet");
          staat.workerBestaat = false;
          return cfOk(null);
        }
      }
      if (pas(/^\/workers\/scripts\/([^/]+)\/subdomain$/) && methode === "POST") {
        if (!staat.workerBestaat) return cfFout(404, "script bestaat niet");
        return cfOk(body);
      }
      return cfFout(404, `geen nep-route ${methode} ${rest}`);
    }

    if (pad.startsWith(SB)) {
      const rest = pad.slice(SB.length);
      let m = null;
      const pas = (re) => {
        m = rest.match(re);
        return m;
      };
      if (rest === "/projects" && methode === "GET") return antwoord(200, staat.projecten);
      if (rest === "/projects" && methode === "POST") {
        const p = {
          ref: `ref${String(++staat.teller).padStart(17, "0")}`,
          name: body.name,
          organization_slug: body.organization_slug,
          region: body.region,
          status: "COMING_UP",
        };
        staat.projecten.push(p);
        return antwoord(201, p);
      }
      if (pas(/^\/projects\/([^/]+)$/)) {
        const i = staat.projecten.findIndex((p) => p.ref === m[1]);
        if (i === -1) return antwoord(404, { message: "project bestaat niet" });
        if (methode === "GET") {
          staat.projecten[i].status = "ACTIVE_HEALTHY";
          return antwoord(200, staat.projecten[i]);
        }
        if (methode === "DELETE") {
          const [weg] = staat.projecten.splice(i, 1);
          return antwoord(200, { ref: weg.ref });
        }
      }
      if (pas(/^\/projects\/([^/]+)\/api-keys$/) && methode === "GET") {
        return antwoord(200, [
          { name: "anon", type: "legacy", api_key: `anon-${m[1]}` },
          { name: "service_role", type: "legacy", api_key: `geheim-sr-${m[1]}` },
          { name: "default", type: "publishable", api_key: `sb_publishable_${m[1]}` },
        ]);
      }
      if (pas(/^\/projects\/([^/]+)\/config\/database\/pooler$/) && methode === "GET") {
        if (staat.poolerFout) return antwoord(staat.poolerFout, { message: "pooler kapot" });
        if (staat.geenPooler) return antwoord(200, []);
        return antwoord(200, [
          {
            database_type: "PRIMARY",
            db_host: staat.projecten.find((x) => x.ref === m[1])?.name?.endsWith("-test")
              ? "aws-1-eu-central-1.pooler.supabase.com"
              : "aws-0-eu-central-1.pooler.supabase.com",
          },
        ]);
      }
      if (pas(/^\/projects\/([^/]+)\/config\/auth$/)) {
        if (methode === "GET") return antwoord(200, { disable_signup: false, ...staat.auth[m[1]] });
        if (methode === "PATCH") {
          staat.auth[m[1]] = { ...staat.auth[m[1]], ...body };
          return antwoord(200, staat.auth[m[1]]);
        }
      }
      if (pas(/^\/projects\/([^/]+)\/database\/password$/) && methode === "PATCH") {
        if (!staat.projecten.some((p) => p.ref === m[1]))
          return antwoord(404, { message: "project bestaat niet" });
        return antwoord(200, { message: "ok" });
      }
      if (pas(/^\/projects\/([^/]+)\/database\/query$/) && methode === "POST") {
        staat.sql.push(body.query);
        staat.sqlOp.push({ ref: m[1], query: body.query });
        return antwoord(201, []);
      }
      return antwoord(404, { message: `geen nep-route ${methode} ${rest}` });
    }
    return antwoord(404, { message: `onbekende host ${u.host}` });
  }

  /** Een nagebootste `createClient(url, sleutel).auth.admin`. */
  function maakAdmin(url, sleutel) {
    const log = (actie, extra = {}) =>
      aanroepen.push({ soort: "admin", methode: actie, url, sleutel, ...extra });
    const lijst = () => staat.gebruikersOp[url] ?? staat.gebruikers;
    return {
      customProviders: {
        async listProviders() {
          log("listProviders");
          return {
            data: { providers: staat.providers.map(({ client_secret, ...p }) => p) },
            error: null,
          };
        },
        async createProvider(params) {
          log("createProvider", { body: params });
          staat.providers.push({ ...params, id: nieuwId("prov") });
          return { data: params, error: null };
        },
        async updateProvider(identifier, params) {
          log("updateProvider", { body: { identifier, ...params } });
          const p = staat.providers.find((q) => q.identifier === identifier);
          Object.assign(p, params);
          return { data: p, error: null };
        },
        async deleteProvider(identifier) {
          log("deleteProvider", { body: { identifier } });
          staat.providers = staat.providers.filter((q) => q.identifier !== identifier);
          return { data: null, error: null };
        },
      },
      async listUsers({ page = 1, perPage = 50 } = {}) {
        log("listUsers");
        const users = lijst().slice((page - 1) * perPage, page * perPage);
        return { data: { users }, error: null };
      },
      async updateUserById(id, attrs) {
        log("updateUserById", { body: { id, ...attrs } });
        const g = lijst().find((q) => q.id === id);
        if (attrs.ban_duration === "none") delete g.banned_until;
        else g.banned_until = "2126-01-01T00:00:00Z";
        return { data: { user: g }, error: null };
      },
    };
  }

  /** Een nagebootste `gh`-CLI: variabelen en secrets per omgeving of op de repo ("repo"). */
  async function gh(args, { invoer } = {}) {
    aanroepen.push({ soort: "gh", methode: `gh ${args[0]} ${args[1]}`, args, invoer });
    const env = args.includes("--env") ? args[args.indexOf("--env") + 1] : "repo";
    const [soort, actie, naam] = args;
    if (soort === "variable" && actie === "list") {
      const v = staat.ghVariabelen[env] ?? {};
      return JSON.stringify(Object.entries(v).map(([name, value]) => ({ name, value })));
    }
    if (soort === "variable" && actie === "set") {
      staat.ghVariabelen[env] = { ...staat.ghVariabelen[env], [naam]: invoer };
      return "";
    }
    if (soort === "variable" && actie === "delete") {
      delete staat.ghVariabelen[env]?.[naam];
      return "";
    }
    if (soort === "secret" && actie === "list") {
      return JSON.stringify((staat.ghSecrets[env] ?? []).map((name) => ({ name })));
    }
    if (soort === "secret" && actie === "set") {
      staat.ghSecrets[env] ??= [];
      if (!staat.ghSecrets[env].includes(naam)) staat.ghSecrets[env].push(naam);
      return "";
    }
    if (soort === "secret" && actie === "delete") {
      staat.ghSecrets[env] = (staat.ghSecrets[env] ?? []).filter((s) => s !== naam);
      return "";
    }
    throw new Error(`nep-gh kent ${args.join(" ")} niet`);
  }

  /** Alle schrijfacties, in volgorde, als korte labels. */
  function schrijfacties() {
    return aanroepen
      .filter((a) => {
        if (a.soort === "fetch") return a.methode !== "GET";
        if (a.soort === "admin") return !["listProviders", "listUsers"].includes(a.methode);
        return !a.args.includes("list");
      })
      .map((a) => {
        if (a.soort === "fetch") {
          const kort = a.pad.replace(CF, "cf").replace(SB, "sb");
          const type = a.body?.type ? ` ${a.body.type}` : "";
          return `${a.methode} ${kort}${type}`;
        }
        if (a.soort === "admin") return `admin ${a.methode}`;
        return `gh ${a.args.slice(0, 3).join(" ")}`;
      });
  }

  return { fetchFn, maakAdmin, gh, aanroepen, staat, schrijfacties };
}
