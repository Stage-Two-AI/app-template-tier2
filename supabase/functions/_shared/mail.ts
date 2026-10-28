// Testmail: in test en lokaal gaat geen mail naar echte mensen. De testdatabase bevat een
// kopie van echte gegevens, dus zonder deze regel kan een mail uit een preview bij een
// echte klant belanden.
//
// Gebruik in een Edge Function, vlak voor het versturen (bijvoorbeeld via Resend):
//
//   import { richtMail } from "../_shared/mail.ts";
//   const mail = richtMail({ aan: klant.email, onderwerp: "Je bestelling", tekst });
//   if (mail) await verstuur(mail); // null: niet versturen
//
// De regel:
//   - OMGEVING leeg of `productie`: de ontvangers blijven zoals ze zijn;
//   - anders, met een TESTMAIL_ADRES: alleen naar dat adres (ook geen cc of bcc), en het
//     onderwerp krijgt `[test] ` ervoor;
//   - anders: niet versturen (null).
//
// OMGEVING en TESTMAIL_ADRES zijn secrets van het Supabase-project. Functies uitrollen in
// de beheer-repo zet ze op de testdatabase: `OMGEVING=test`, en TESTMAIL_ADRES uit
// `testmail` in stack.config.json. Productie krijgt ze niet, dus daar verandert niets.
//
// Deno én Node (de unittests): Deno.env alleen via globalThis, zodat de typecontrole en
// vitest dit bestand ook kunnen lezen.

/** Een mail, met in elk geval ontvangers en een onderwerp; de rest gaat ongewijzigd mee. */
export type Mail = {
  aan: string | readonly string[];
  onderwerp: string;
  cc?: string | readonly string[];
  bcc?: string | readonly string[];
};

/** Waar de functie draait, zoals de secrets OMGEVING en TESTMAIL_ADRES het zeggen. */
export type MailOmgeving = {
  omgeving?: string | null;
  testmailAdres?: string | null;
};

/** De mail zoals hij in test en lokaal weggaat: alleen naar het testadres, zonder cc en bcc. */
export type Testmail<T extends Mail> = Omit<T, "aan" | "cc" | "bcc"> & { aan: string[] };

const VOORVOEGSEL = "[test] ";

/** Is dit productie? Ook een lege OMGEVING telt als productie: daar is niets gezet. */
export function isProductie(omgeving: string | null | undefined): boolean {
  const o = (omgeving ?? "").trim().toLowerCase();
  return o === "" || o === "productie";
}

/**
 * De mail zoals hij echt weg mag, of null als hij niet verstuurd mag worden. In productie
 * blijft alles zoals het is; daarbuiten gaat hij alleen naar het testadres.
 */
export function bepaalOntvangers<T extends Mail>(
  mail: T,
  { omgeving, testmailAdres }: MailOmgeving,
): T | Testmail<T> | null {
  if (isProductie(omgeving)) return mail;
  const adres = (testmailAdres ?? "").trim();
  if (!adres) return null;
  const { aan: _aan, cc: _cc, bcc: _bcc, ...rest } = mail;
  const onderwerp = mail.onderwerp.startsWith(VOORVOEGSEL)
    ? mail.onderwerp
    : `${VOORVOEGSEL}${mail.onderwerp}`;
  return { ...rest, aan: [adres], onderwerp } as Testmail<T>;
}

type DenoEnv = { Deno?: { env: { get(naam: string): string | undefined } } };

/** OMGEVING en TESTMAIL_ADRES uit de omgeving van de functie (Deno.env). */
export function mailOmgeving(): MailOmgeving {
  const env = (globalThis as DenoEnv).Deno?.env;
  return {
    omgeving: env?.get("OMGEVING") ?? null,
    testmailAdres: env?.get("TESTMAIL_ADRES") ?? null,
  };
}

/** bepaalOntvangers met de omgeving van deze functie. */
export function richtMail<T extends Mail>(mail: T) {
  return bepaalOntvangers(mail, mailOmgeving());
}
