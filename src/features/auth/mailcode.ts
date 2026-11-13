import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

/**
 * Inloggen met een code per mail: de stappen, de controles en de toestanden, zonder React
 * en zonder `window`. De pagina (inlog-met-code.tsx) en de hook (use-mailcode.ts) tekenen
 * alleen wat hier uitkomt. Zo is dezelfde logica ook te gebruiken waar de server de pagina
 * maakt: roep daar `vraagCode`, `controleerCode` en `controleerLink` aan met de
 * Supabase-client van de server.
 *
 * Twee regels die hier bewaakt worden:
 *
 * 1. Hetzelfde antwoord bij een bekend en een onbekend adres. Wie een adres invult, komt
 *    altijd bij "vul de code in" uit, ook als Supabase het adres weigert. Zo is aan deze
 *    pagina niet te zien wie een account heeft. Alleen wat niets over het adres zegt, wordt
 *    getoond: te veel pogingen, geen verbinding (er kwam helemaal geen antwoord), of inloggen
 *    per mail staat helemaal uit. Een antwoord met een storing (5xx) hoort daar niet bij: een
 *    hook van de inrichting die één adres weigert, kan er zo uitzien.
 * 2. Deze pagina geeft niemand rechten. Wat iemand na het inloggen mag, bepaalt de database
 *    (zie `sessie_via_cloudflare()` in supabase/migrations).
 */

/** Tien cijfers en een kwartier geldig: zo staat het ook in supabase/config.toml en in de inrichting. */
export const CODE_LENGTE = 10;
export const CODE_GELDIG_MS = 15 * 60 * 1000;
/** Zo lang wacht de knop "nieuwe code". Supabase zelf weigert een tweede mail binnen een minuut. */
export const WACHT_OPNIEUW_MS = 60 * 1000;
/**
 * Zo lang onthoudt het tabblad naar welk adres de code ging. Kort: genoeg om naar de mail-app
 * te wisselen, en op een gedeelde computer staat het adres van de vorige er niet lang.
 */
export const ONTHOUD_ADRES_MS = 5 * 60 * 1000;

/** Het deel van de Supabase-auth dat hier nodig is; zo is het los te testen. */
export type MailcodeAuth = Pick<SupabaseClient["auth"], "signInWithOtp" | "verifyOtp">;

export type FoutSoort =
  | "adres"
  | "code"
  | "verlopen"
  | "link"
  | "te-vaak"
  | "verbinding"
  | "uit"
  | "robot"
  | "dienst"
  | "bevestig-adres"
  | "adres-bezet";
export type Fout = { soort: FoutSoort; tekst: string };

const TEKST: Record<FoutSoort, string> = {
  adres: "Dit lijkt geen geldig e-mailadres.",
  code: "Deze code klopt niet. Controleer de cijfers of vraag een nieuwe code aan.",
  verlopen: "Deze code is verlopen. Vraag een nieuwe code aan.",
  link: "Deze link is verlopen of al gebruikt. Vraag hieronder een nieuwe code aan.",
  "te-vaak": "Te veel pogingen. Wacht een minuut en probeer het dan opnieuw.",
  verbinding: "Er is geen verbinding. Controleer je internet en probeer het opnieuw.",
  uit: "Inloggen per mail staat voor deze app niet aan.",
  robot:
    "De controle of je geen robot bent is niet gelukt. Wacht even tot de controle klaar is en probeer het opnieuw. Blijft het zo, ververs dan de pagina.",
  dienst: "Inloggen is niet gelukt. Probeer het opnieuw.",
  "bevestig-adres":
    "Je e-mailadres moet nog één keer bevestigd worden. Je hebt daarvoor een mail gekregen: klik op de link in die mail. Kom daarna terug op deze pagina en kies opnieuw Inloggen voor medewerkers.",
  "adres-bezet":
    "Inloggen voor medewerkers lukt nog niet. Op dit e-mailadres bestaat al een account dat nog niet bevestigd is, bijvoorbeeld omdat het adres eerder in het formulier voor klanten is ingevuld. Vraag je beheerder om dat account in Supabase (Authentication, Users) te bevestigen of te verwijderen. Daarna werkt de knop.",
};

/** Fouten die niet over het e-mailadres van een klant gaan en dus niet bij dat veld horen. */
export function isFoutVanDienst(soort: FoutSoort): boolean {
  return soort === "dienst" || soort === "bevestig-adres" || soort === "adres-bezet";
}

export function fout(soort: FoutSoort): Fout {
  return { soort, tekst: TEKST[soort] };
}

/** Een adres zoals Supabase het bewaart: zonder spaties eromheen, in kleine letters. */
const adresSchema = z.string().trim().toLowerCase().pipe(z.email());

export function leesAdres(invoer: string): string | null {
  const uitkomst = adresSchema.safeParse(invoer);
  return uitkomst.success ? uitkomst.data : null;
}

/**
 * Wat iemand in het codevak typt of plakt, teruggebracht tot cijfers. "12345 67890" en
 * "12345-67890" (zo plakken sommige mailprogramma's) worden "1234567890"; de rest valt weg.
 */
export function leesCode(invoer: string): string {
  return invoer.replace(/\D/g, "").slice(0, CODE_LENGTE);
}

export function isHeleCode(code: string): boolean {
  return new RegExp(`^\\d{${CODE_LENGTE}}$`).test(code);
}

/** Hoeveel hele seconden nog tot "nieuwe code" weer mag. Nul: het mag. */
export function wachtNog(verstuurdOp: number | null, nu: number): number {
  if (verstuurdOp === null) return 0;
  return Math.max(0, Math.ceil((verstuurdOp + WACHT_OPNIEUW_MS - nu) / 1000));
}

export function isVerlopen(verstuurdOp: number | null, nu: number): boolean {
  return verstuurdOp !== null && nu - verstuurdOp > CODE_GELDIG_MS;
}

type AuthFout = { status?: number; code?: string; name?: string };

/** Een fout die niets over het adres zegt en die de gebruiker dus mag zien. Anders null. */
function zichtbareFout(error: AuthFout): Fout | null {
  if (error.status === 429 || error.code?.startsWith("over_")) return fout("te-vaak");
  if (error.code === "email_provider_disabled") return fout("uit");
  // De controle tegen robots (captcha) staat aan bij Supabase en keurde deze aanvraag af.
  if (error.code === "captcha_failed") return fout("robot");
  // Alleen als er helemaal geen antwoord kwam, is het de verbinding. Een antwoord met een
  // storing (5xx) kan van één adres afhangen en mag er dus niet anders uitzien dan een ander.
  if (error.status === undefined || error.status === 0) return fout("verbinding");
  return null;
}

/** Bij het controleren van een code of link: een storing is geen "code klopt niet". */
function storing(error: AuthFout): Fout | null {
  return error.status !== undefined && error.status >= 500 ? fout("dienst") : null;
}

/**
 * `verstuurd` (alleen bij `vraagCode`): heeft Supabase de aanvraag echt aangenomen? De pagina
 * toont bij een stille weigering hetzelfde als bij een verstuurde mail (regel 1 hierboven),
 * maar onthoudt dan niet dat er hier een code is aangevraagd.
 */
export type Uitkomst = { ok: true; verstuurd?: boolean } | { ok: false; fout: Fout };

/**
 * Stap 1: vraag een code aan voor dit adres. Supabase stuurt één mail met de code en een
 * link. `shouldCreateUser` staat aan: wie een account mag krijgen, bewaakt de server (de
 * before-user-created-hook van de inrichting), niet de browser.
 *
 * Staat bij Supabase de controle tegen robots aan, dan weigert Supabase elke aanvraag zonder
 * `captchaToken`. Het controleren van de code (stap 2) vraagt er geen.
 */
export async function vraagCode(
  auth: MailcodeAuth,
  adres: string,
  terugNaar: string,
  /** Het bewijs van de controle tegen robots; alleen als die aan staat (robotcontrole.tsx). */
  captchaToken?: string,
): Promise<Uitkomst> {
  const email = leesAdres(adres);
  if (!email) return { ok: false, fout: fout("adres") };
  try {
    const { error } = await auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: terugNaar,
        shouldCreateUser: true,
        ...(captchaToken ? { captchaToken } : {}),
      },
    });
    if (!error) return { ok: true, verstuurd: true };
    const zichtbaar = zichtbareFout(error);
    // Elke andere weigering (onbekend adres, geen nieuwe accounts, een hook die nee zegt, ook
    // als die als storing terugkomt) ziet er voor de gebruiker hetzelfde uit als een
    // verstuurde mail.
    return zichtbaar ? { ok: false, fout: zichtbaar } : { ok: true, verstuurd: false };
  } catch {
    return { ok: false, fout: fout("verbinding") };
  }
}

/**
 * Stap 2: controleer de code. Supabase zegt bij een foute en bij een verlopen code hetzelfde;
 * daarom kijken we zelf naar de klok om te zeggen dat de code verlopen is.
 */
export async function controleerCode(
  auth: MailcodeAuth,
  adres: string,
  invoer: string,
  tijd: { verstuurdOp: number | null; nu: number },
): Promise<Uitkomst> {
  const email = leesAdres(adres);
  const token = leesCode(invoer);
  if (!email || !isHeleCode(token)) return { ok: false, fout: fout("code") };
  try {
    const { error } = await auth.verifyOtp({ email, token, type: "email" });
    if (!error) return { ok: true };
    const zichtbaar = zichtbareFout(error) ?? storing(error);
    if (zichtbaar) return { ok: false, fout: zichtbaar };
    return { ok: false, fout: fout(isVerlopen(tijd.verstuurdOp, tijd.nu) ? "verlopen" : "code") };
  } catch {
    return { ok: false, fout: fout("verbinding") };
  }
}

/**
 * De link in de mail wijst naar de inlogpagina met `?token_hash=...&type=email`. Alleen dat
 * ene type wordt aangenomen: zo kan niemand via deze pagina een ander soort link (wachtwoord
 * herstellen, adres wijzigen) laten bevestigen.
 */
const linkSchema = z.object({
  token_hash: z.string().regex(/^[A-Za-z0-9_-]{16,200}$/),
  type: z.literal("email"),
});

export function leesLink(zoekdeel: string): { tokenHash: string } | null {
  const params = new URLSearchParams(zoekdeel);
  const uitkomst = linkSchema.safeParse({
    token_hash: params.get("token_hash"),
    type: params.get("type"),
  });
  return uitkomst.success ? { tokenHash: uitkomst.data.token_hash } : null;
}

/** De link uit de mail bevestigen. Gebeurt pas na een klik op de knop, nooit vanzelf. */
export async function controleerLink(auth: MailcodeAuth, tokenHash: string): Promise<Uitkomst> {
  try {
    const { error } = await auth.verifyOtp({ token_hash: tokenHash, type: "email" });
    if (!error) return { ok: true };
    return { ok: false, fout: zichtbareFout(error) ?? storing(error) ?? fout("link") };
  } catch {
    return { ok: false, fout: fout("verbinding") };
  }
}

/**
 * Kwam Supabase terug op de inlogpagina met een fout in het adres? Geeft dan een vaste
 * tekst. De tekst uit het adres zelf wordt nooit getoond: deze pagina staat open voor
 * iedereen, en dan kan een vreemde anders met een link eigen tekst op het inlogscherm zetten.
 *
 * Eén weigering krijgt een eigen uitleg, omdat de gebruiker er zelf iets aan kan doen.
 * Cloudflare zegt er bij Supabase niet bij dat een adres gecontroleerd is. Een medewerker
 * die voor het eerst via Cloudflare inlogt, krijgt daarom van Supabase een mail om zijn
 * adres te bevestigen, en komt hier terug met `provider_email_needs_verification` ("Unverified
 * email with custom:cloudflare. A confirmation email has been sent ..."). Hoort het adres al
 * bij een ander account, dan komt er geen mail ("... Verify the email with custom:cloudflare
 * in order to sign in"); dat kan alleen de beheerder oplossen. De Engelse tekst dient hier
 * alleen om die twee uit elkaar te houden.
 *
 * Die uitleg komt er alleen als deze browser de inlog via de dienst zelf net is begonnen
 * (`zelfBegonnen`, zie `merkDienstInlog`). Anders kan een vreemde met een link kiezen welke
 * melding iemand op de echte inlogpagina ziet ("klik op de link in die mail"), en krijgt
 * iedereen de neutrale melding.
 */
export function foutUitAdres(zoekdeel: string, hash: string, zelfBegonnen = false): Fout | null {
  const params = new URLSearchParams(zoekdeel);
  const anker = new URLSearchParams(hash.replace(/^#/, ""));
  const lees = (naam: string) => params.get(naam) ?? anker.get(naam);
  const code = lees("error_code");
  const uitleg = lees("error_description") ?? "";
  if (!lees("error") && !code && !uitleg) return null;
  if (code === "otp_expired") return fout("link");
  const onbevestigd =
    code === "provider_email_needs_verification" || /^Unverified email with /i.test(uitleg);
  if (zelfBegonnen && onbevestigd) {
    return fout(
      /confirmation email has been sent/i.test(uitleg) ? "bevestig-adres" : "adres-bezet",
    );
  }
  return fout("dienst");
}

// --- De toestand van het formulier -------------------------------------------------------

export type Toestand = {
  /** `link`: iemand kwam binnen via de link uit de mail en moet nog op de knop klikken. */
  stap: "adres" | "code" | "link";
  /** Het adres waar de code naartoe is. Leeg zolang er nog niets verstuurd is. */
  email: string;
  bezig: null | "versturen" | "controleren" | "opnieuw";
  fout: Fout | null;
  /** Een geruststellende regel, bijvoorbeeld na "nieuwe code". */
  melding: string | null;
  verstuurdOp: number | null;
};

export const BEGIN: Toestand = {
  stap: "adres",
  email: "",
  bezig: null,
  fout: null,
  melding: null,
  verstuurdOp: null,
};

export type Actie =
  | { soort: "bezig"; waarmee: NonNullable<Toestand["bezig"]> }
  | { soort: "verstuurd"; email: string; op: number; opnieuw: boolean }
  | { soort: "mislukt"; fout: Fout }
  | { soort: "ander-adres" }
  | { soort: "link-mislukt"; fout: Fout };

export function volgende(toestand: Toestand, actie: Actie): Toestand {
  switch (actie.soort) {
    case "bezig":
      return { ...toestand, bezig: actie.waarmee, fout: null, melding: null };
    case "verstuurd":
      return {
        stap: "code",
        email: actie.email,
        bezig: null,
        fout: null,
        melding: actie.opnieuw ? "Er is een nieuwe code verstuurd." : null,
        verstuurdOp: actie.op,
      };
    case "mislukt":
      return { ...toestand, bezig: null, fout: actie.fout, melding: null };
    case "ander-adres":
      return { ...BEGIN, email: toestand.email };
    case "link-mislukt":
      return { ...BEGIN, fout: actie.fout };
  }
}

// --- Onthouden tijdens het wisselen naar de mail-app -------------------------------------

const SLEUTEL = "inlogcode";
type Opslag = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const bewaardSchema = z.object({ email: z.email(), verstuurdOp: z.number() });

/**
 * Op een telefoon wisselt iemand naar de mail-app om de code te lezen, en de browser laadt
 * de pagina daarna soms opnieuw. Daarom onthoudt dit tabblad (sessionStorage, dus alleen dit
 * tabblad en tot het sluit) vijf minuten naar welk adres de code ging. Er wordt geen code
 * bewaard.
 */
export function bewaar(opslag: Opslag, toestand: Toestand): void {
  try {
    if (toestand.stap === "code" && toestand.verstuurdOp !== null) {
      const waarde = { email: toestand.email, verstuurdOp: toestand.verstuurdOp };
      opslag.setItem(SLEUTEL, JSON.stringify(waarde));
    } else {
      opslag.removeItem(SLEUTEL);
    }
  } catch {
    // Geen opslag (privévenster, vol): dan onthouden we niets; inloggen werkt gewoon.
  }
}

export function herstel(opslag: Opslag, nu: number): Toestand {
  try {
    const bewaard = bewaardSchema.safeParse(JSON.parse(opslag.getItem(SLEUTEL) ?? "null"));
    const oud = bewaard.success ? nu - bewaard.data.verstuurdOp : -1;
    if (bewaard.success && oud >= 0 && oud <= ONTHOUD_ADRES_MS) {
      return { ...BEGIN, stap: "code", ...bewaard.data };
    }
  } catch {
    // Onleesbaar: begin gewoon opnieuw.
  }
  return BEGIN;
}

// --- Is deze inlog hier begonnen? ---------------------------------------------------------

const SLEUTEL_AANGEVRAAGD = "inlogcode-aangevraagd";
const SLEUTEL_DIENST = "inlog-via-dienst";

function zetTijd(opslag: Opslag, sleutel: string, nu: number): void {
  try {
    opslag.setItem(sleutel, String(nu));
  } catch {
    // Geen opslag: dan weten we het straks niet, en kiest de pagina de voorzichtige kant.
  }
}

function binnenTijd(opslag: Opslag, sleutel: string, nu: number): boolean {
  try {
    const op = Number(opslag.getItem(sleutel) ?? Number.NaN);
    return Number.isFinite(op) && nu - op >= 0 && nu - op <= CODE_GELDIG_MS;
  } catch {
    return false;
  }
}

function wis(opslag: Opslag, sleutel: string): void {
  try {
    opslag.removeItem(sleutel);
  } catch {
    // Niets te wissen.
  }
}

/**
 * Een vingerafdruk van een e-mailadres (SHA-256, als hex): zo onthoudt de browser welk adres
 * hier een code aanvroeg, zonder het adres zelf op te slaan.
 */
export async function adresVingerafdruk(adres: string): Promise<string> {
  const tekst = new TextEncoder().encode(leesAdres(adres) ?? adres.trim().toLowerCase());
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const hash = new Uint8Array(await subtle.digest("SHA-256", tekst));
    return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Zonder Web Crypto (een pagina over http buiten localhost): een eenvoudige vingerafdruk.
  let h = 0x811c9dc5;
  for (const b of tekst) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return `fnv-${h.toString(16)}`;
}

const aanvraagSchema = z.object({ adres: z.string().min(8), op: z.number() });

/**
 * Deze browser heeft net een code aangevraagd, en Supabase heeft die aanvraag aangenomen.
 * Bewaard worden de vingerafdruk van het adres en het tijdstip, niet het adres zelf, in
 * localStorage: een link uit de mail opent meestal in een nieuw tabblad van dezelfde browser,
 * en dat tabblad moet dit kunnen zien.
 *
 * Komt iemand binnen via een link terwijl er geen aanvraag is, dan is de mail niet in deze
 * browser aangevraagd en waarschuwt de pagina eerst (inlog-met-code.tsx): zo'n link kan van
 * een ander komen, die je in zíjn account laat inloggen. Na het inloggen vergelijkt de app de
 * vingerafdruk met het adres van het account (app-met-database.tsx) en zegt het als dat niet
 * het aangevraagde adres is: een ander kan je eerst zelf een code laten aanvragen en je dan
 * zijn link sturen.
 */
export function merkAangevraagd(opslag: Opslag, adres: string, nu: number): void {
  try {
    opslag.setItem(SLEUTEL_AANGEVRAAGD, JSON.stringify({ adres, op: nu }));
  } catch {
    // Geen opslag: dan weten we het straks niet, en kiest de pagina de voorzichtige kant.
  }
}

/** De aanvraag van de afgelopen tijd die een code geldig is, of null. */
export function leesAanvraag(opslag: Opslag, nu: number): { adres: string; op: number } | null {
  try {
    const bewaard = aanvraagSchema.safeParse(
      JSON.parse(opslag.getItem(SLEUTEL_AANGEVRAAGD) ?? "null"),
    );
    if (!bewaard.success) return null;
    const oud = nu - bewaard.data.op;
    return oud >= 0 && oud <= CODE_GELDIG_MS ? bewaard.data : null;
  } catch {
    return null;
  }
}

export function isHierAangevraagd(opslag: Opslag, nu: number): boolean {
  return leesAanvraag(opslag, nu) !== null;
}

export function wisAangevraagd(opslag: Opslag): void {
  wis(opslag, SLEUTEL_AANGEVRAAGD);
}

/**
 * Dit tabblad is net naar de inlogdienst gestuurd (de knop voor medewerkers). Bij terugkomst
 * weet de pagina zo dat een melding van de dienst bij een eigen poging hoort, en de app dat
 * een sessie op /login van een verse inlog komt.
 */
export function merkDienstInlog(opslag: Opslag, nu: number): void {
  zetTijd(opslag, SLEUTEL_DIENST, nu);
}

export function isDienstInlogBegonnen(opslag: Opslag, nu: number): boolean {
  return binnenTijd(opslag, SLEUTEL_DIENST, nu);
}

export function wisDienstInlog(opslag: Opslag): void {
  wis(opslag, SLEUTEL_DIENST);
}
