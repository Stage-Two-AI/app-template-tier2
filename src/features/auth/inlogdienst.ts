import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Welke inlogdienst deze app gebruikt, komt uit `VITE_INLOGDIENST` (zie lib/env.ts).
 * Het is een instelling, geen code. De beheer-repo richt alleen `cloudflare` in: in
 * productie loopt inloggen altijd via Cloudflare Access. azure, google en mailcode
 * vragen eigen instellingen in Supabase die de inrichting niet zet.
 *
 *   cloudflare  Cloudflare Access is de inlogdienst van Supabase (custom OIDC-provider
 *               `custom:cloudflare`). De standaard in productie: één login, en wie niet
 *               door de deur mag, krijgt ook geen Supabase-account.
 *   azure       Supabase logt zelf in bij Microsoft.
 *   google      Supabase logt zelf in bij Google.
 *   mailcode    Supabase stuurt een mail met een code van zes cijfers en een link.
 *   wachtwoord  e-mail en wachtwoord; alleen lokaal en in CI, voor de tests.
 *
 * Een klantportaal zet er twee naast elkaar: `VITE_INLOGDIENST=cloudflare,mailcode`.
 * Medewerkers loggen dan in via Cloudflare, klanten met een code per mail. Welke rechten
 * iemand daarna heeft, bepaalt de database en nooit deze pagina: zie
 * `sessie_via_cloudflare()` in supabase/migrations en docs/WERKWIJZE.md.
 */
export const INLOGDIENSTEN = ["cloudflare", "azure", "google", "mailcode", "wachtwoord"] as const;
export type Inlogdienst = (typeof INLOGDIENSTEN)[number];

/**
 * Leest `VITE_INLOGDIENST`: één dienst (`cloudflare`) of een lijst met komma's
 * (`cloudflare,mailcode`). Geeft de diensten in de opgegeven volgorde, of een fout in
 * gewone taal. Eén dienst geeft precies wat het altijd gaf: een lijst met die ene dienst.
 *
 * `wachtwoord` staat altijd alleen: het is er voor lokaal en de tests, en hoort nooit
 * naast een echte dienst op een inlogpagina te staan.
 */
export function leesInlogdiensten(
  tekst: string,
): { ok: true; diensten: Inlogdienst[] } | { ok: false; fout: string } {
  const namen = tekst.split(",").map((naam) => naam.trim());
  const diensten: Inlogdienst[] = [];
  for (const naam of namen) {
    const dienst = INLOGDIENSTEN.find((bekend) => bekend === naam);
    if (!dienst) {
      return {
        ok: false,
        fout: `VITE_INLOGDIENST kent "${naam}" niet. Kies uit: ${INLOGDIENSTEN.join(", ")}; meer dan één mag, met een komma ertussen.`,
      };
    }
    if (diensten.includes(dienst)) {
      return { ok: false, fout: `VITE_INLOGDIENST noemt "${dienst}" twee keer.` };
    }
    diensten.push(dienst);
  }
  if (diensten.length > 1 && diensten.includes("wachtwoord")) {
    return {
      ok: false,
      fout: "VITE_INLOGDIENST: `wachtwoord` is alleen voor lokaal en de tests en kan niet naast een andere dienst staan.",
    };
  }
  return { ok: true, diensten };
}

/** Het deel van de Supabase-auth dat hier nodig is; zo is het los te testen. */
export type InlogAuth = Pick<SupabaseClient["auth"], "signInWithOAuth" | "signInWithOtp">;

/** Hoe de loginpagina eruitziet bij een dienst. */
export function inlogVorm(dienst: Inlogdienst): "doorsturen" | "knop" | "mailcode" | "wachtwoord" {
  switch (dienst) {
    case "cloudflare":
      return "doorsturen";
    case "azure":
    case "google":
      return "knop";
    case "mailcode":
      return "mailcode";
    case "wachtwoord":
      return "wachtwoord";
  }
}

type Opties = { terugNaar: string; email?: string };

/**
 * Start het inloggen bij de gekozen dienst. Bij een OAuth-dienst stuurt Supabase de
 * browser daarna door; bij mailcode komt er een mail met een code en een link. Gooit bij
 * een fout. De inlogpagina met de code gebruikt voor mailcode de stappen uit mailcode.ts,
 * die ook de antwoorden van Supabase vertalen.
 */
export async function startInloggen(
  dienst: Inlogdienst,
  auth: InlogAuth,
  { terugNaar, email }: Opties,
): Promise<void> {
  if (dienst === "wachtwoord") {
    throw new Error("Inloggen met een wachtwoord gaat via het formulier, niet via startInloggen.");
  }

  if (dienst === "mailcode") {
    if (!email) throw new Error("Vul eerst je e-mailadres in.");
    // shouldCreateUser mag aan: wie een account mag krijgen, bewaakt de server met de
    // before-user-created-hook uit de inrichting. Een instelling in de browser beschermt
    // niets, want die kan iedereen omzeilen.
    const { error } = await auth.signInWithOtp({
      email,
      options: { emailRedirectTo: terugNaar, shouldCreateUser: true },
    });
    if (error) throw new Error(error.message);
    return;
  }

  const provider = dienst === "cloudflare" ? "custom:cloudflare" : dienst;
  const { error } = await auth.signInWithOAuth({ provider, options: { redirectTo: terugNaar } });
  if (error) throw new Error(error.message);
}
