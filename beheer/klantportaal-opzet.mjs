/**
 * Gedeelde opzet voor de verdedigingstests van het klantportaal (klantportaal-*.test.mjs):
 * één klant (Winco, voorvoegsel wi-), één app (direct), als gewone app (DEUR) en als
 * klantportaal (PORTAAL). Die tests spelen de aanvallen na die bij het bouwen van uitgave 43
 * zijn geprobeerd, en bewijzen dat ze mislukken. Geen testbestand zelf (geen `.test.` in de
 * naam), net als nep-wolk.mjs.
 */
import { richtIn } from "./inrichten-cloudflare.mjs";
import { cloudflareClient } from "./lib/cloudflare.mjs";
import { supabaseBeheer } from "./lib/supabase.mjs";

export const GROEPEN = { kantoor: { domeinen: ["winco.nl"], uitsluiten: ["oud@winco.nl"] } };
export const AFZENDER = "Winco Direct <noreply@wincoapps.com>";
export const SITEKEY = "0x4AAAAAAAOpenbareSleutel";
export const DEUR = { groepen: GROEPEN, apps: { direct: ["kantoor"] } };
export const PORTAAL_APP = {
  groepen: ["kantoor"],
  klantportaal: true,
  afzender: AFZENDER,
  turnstile_sitekey: SITEKEY,
};
export const PORTAAL = { groepen: GROEPEN, apps: { direct: PORTAAL_APP } };
export const ARG = {
  app: "direct",
  hostname: "direct.wincoapps.com",
  worker: "wi-direct",
  repo: "Winco-Holland-B-V/direct",
  voorvoegsel: "wi-",
  droogloop: false,
};
export const SMTP = "re_GeheimeSleutelVanResend123";
export const TURNSTILE = "0x4GeheimVanTurnstile456";
export const NAMEN = { deur: "wi-direct", inlog: "wi-direct-inlog", worker: "wi-direct-worker" };
export const HOOKS = { aanmelden: "wi_portaal_voor_aanmelden", token: "wi_portaal_voor_token" };

export function opzet(w, toegang, extra = {}) {
  const geheimen = [];
  return {
    cf: cloudflareClient({
      fetchFn: w.fetchFn,
      token: "cf-token",
      accountId: "acc",
      teamDomein: "stagetwo",
    }),
    supabase: supabaseBeheer({
      fetchFn: w.fetchFn,
      token: "sb-token",
      orgSlug: "winco",
      slaap: async () => {},
    }),
    maakAdmin: w.maakAdmin,
    gh: w.gh,
    wachtOpDiscovery: async () => {},
    toegang,
    accountId: "acc",
    wachtwoord: () => "GeheimDatabaseWachtwoord1234567",
    maskeer: (waarde) => geheimen.push(waarde),
    geheimen,
    smtpWachtwoord: SMTP,
    captchaGeheim: TURNSTILE,
    ...extra,
  };
}

/**
 * Van deur naar klantportaal gaat in twee runs van App inrichten: de eerste zet alles klaar
 * en laat de deur staan, de tweede haalt hem weg. Geeft het resultaat van de tweede.
 */
export async function naarPortaal(w, toegang = PORTAAL, arg = ARG, extra = {}) {
  await richtIn(arg, opzet(w, toegang, extra));
  return richtIn(arg, opzet(w, toegang, extra));
}

export const app = (w, naam) => w.staat.apps.find((a) => a.name === naam);
export const project = (w, naam = "wi-direct") => w.staat.projecten.find((p) => p.name === naam);
export const auth = (w, naam) => w.staat.auth[project(w, naam).ref];
export const stap = (r, naam) => r.stappen.find((s) => s.stap === naam)?.actie;
export const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const cf = (email) => ({ provider: "custom:cloudflare", identity_data: { email } });
export const mail = (email) => ({ provider: "email", identity_data: { email } });
export const klant = (n, email) => ({
  id: ID(n),
  email,
  identities: [mail(email)],
  app_metadata: { provider: "email", providers: ["email"] },
});
export const medewerker = (n, email, extra = {}) => ({
  id: ID(n),
  email,
  identities: [cf(email)],
  app_metadata: { provider: "custom:cloudflare", providers: ["custom:cloudflare"] },
  ...extra,
});
export const bans = (w) =>
  w.aanroepen
    .filter((a) => a.methode === "updateUserById" && a.body.ban_duration !== "none")
    .map((a) => a.body.id);
export const afgemeld = (w) =>
  w.staat.sql
    .filter((q) => q.startsWith("delete from auth.sessions"))
    .map((q) => q.match(/'([^']+)'/)[1]);
/** De leesvragen naar de auth-config van een project, sinds het legen van `aanroepen`. */
export const authGelezen = (w, ref) =>
  w.aanroepen.filter(
    (a) => a.soort === "fetch" && a.methode === "GET" && a.pad.endsWith(`/${ref}/config/auth`),
  ).length;
