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
 *    getoond: te veel pogingen, geen verbinding, of inloggen per mail staat helemaal uit.
 * 2. Deze pagina geeft niemand rechten. Wat iemand na het inloggen mag, bepaalt de database
 *    (zie `sessie_via_cloudflare()` in supabase/migrations).
 */

/** Zes cijfers en een kwartier geldig: zo staat het ook in supabase/config.toml en in de inrichting. */
export const CODE_LENGTE = 6;
export const CODE_GELDIG_MS = 15 * 60 * 1000;
/** Zo lang wacht de knop "nieuwe code". Supabase zelf weigert een tweede mail binnen een minuut. */
export const WACHT_OPNIEUW_MS = 60 * 1000;

/** Het deel van de Supabase-auth dat hier nodig is; zo is het los te testen. */
export type MailcodeAuth = Pick<SupabaseClient["auth"], "signInWithOtp" | "verifyOtp">;

export type FoutSoort = "adres" | "code" | "verlopen" | "link" | "te-vaak" | "verbinding" | "uit";
export type Fout = { soort: FoutSoort; tekst: string };

const TEKST: Record<FoutSoort, string> = {
  adres: "Dit lijkt geen geldig e-mailadres.",
  code: "Deze code klopt niet. Controleer de cijfers of vraag een nieuwe code aan.",
  verlopen: "Deze code is verlopen. Vraag een nieuwe code aan.",
  link: "Deze link is verlopen of al gebruikt. Vraag hieronder een nieuwe code aan.",
  "te-vaak": "Te veel pogingen. Wacht een minuut en probeer het dan opnieuw.",
  verbinding: "Er is geen verbinding. Controleer je internet en probeer het opnieuw.",
  uit: "Inloggen per mail staat voor deze app niet aan.",
};

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
 * Wat iemand in het codevak typt of plakt, teruggebracht tot cijfers. "123 456" en
 * "123-456" (zo plakken sommige mailprogramma's) worden "123456"; de rest valt weg.
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
  const geenAntwoord = error.status === undefined || error.status === 0 || error.status >= 500;
  if (geenAntwoord || error.name === "AuthRetryableFetchError") return fout("verbinding");
  return null;
}

export type Uitkomst = { ok: true } | { ok: false; fout: Fout };

/**
 * Stap 1: vraag een code aan voor dit adres. Supabase stuurt één mail met de code en een
 * link. `shouldCreateUser` staat aan: wie een account mag krijgen, bewaakt de server (de
 * before-user-created-hook van de inrichting), niet de browser.
 */
export async function vraagCode(
  auth: MailcodeAuth,
  adres: string,
  terugNaar: string,
): Promise<Uitkomst> {
  const email = leesAdres(adres);
  if (!email) return { ok: false, fout: fout("adres") };
  try {
    const { error } = await auth.signInWithOtp({
      email,
      options: { emailRedirectTo: terugNaar, shouldCreateUser: true },
    });
    if (!error) return { ok: true };
    const zichtbaar = zichtbareFout(error);
    // Elke andere weigering (onbekend adres, geen nieuwe accounts, een hook die nee zegt)
    // ziet er voor de gebruiker hetzelfde uit als een verstuurde mail.
    return zichtbaar ? { ok: false, fout: zichtbaar } : { ok: true };
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
    const zichtbaar = zichtbareFout(error);
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
    return { ok: false, fout: zichtbareFout(error) ?? fout("link") };
  } catch {
    return { ok: false, fout: fout("verbinding") };
  }
}

/**
 * Kwam Supabase terug op de inlogpagina met een fout in het adres? Geeft dan een vaste
 * tekst. De tekst uit het adres zelf wordt nooit getoond: deze pagina staat open voor
 * iedereen, en dan kan een vreemde anders met een link eigen tekst op het inlogscherm zetten.
 */
export function foutUitAdres(zoekdeel: string, hash: string): Fout | null {
  const params = new URLSearchParams(zoekdeel);
  const anker = new URLSearchParams(hash.replace(/^#/, ""));
  const lees = (naam: string) => params.get(naam) ?? anker.get(naam);
  if (!lees("error") && !lees("error_code") && !lees("error_description")) return null;
  if (lees("error_code") === "otp_expired") return fout("link");
  return { soort: "link", tekst: "Inloggen is niet gelukt. Probeer het opnieuw." };
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
 * tabblad en tot het sluit) naar welk adres de code ging. Er wordt geen code bewaard.
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
    if (bewaard.success && !isVerlopen(bewaard.data.verstuurdOp, nu)) {
      return { ...BEGIN, stap: "code", ...bewaard.data };
    }
  } catch {
    // Onleesbaar: begin gewoon opnieuw.
  }
  return BEGIN;
}
