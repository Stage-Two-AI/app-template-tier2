import type { Session } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { startInloggen } from "@/features/auth/inlogdienst";
import { merkDienstInlog } from "@/features/auth/mailcode";
import { supabase } from "@/lib/supabase";

/**
 * Hulp voor een klantportaal: weten of iemand nu medewerkerrechten heeft, en het zeggen als
 * die verlopen zijn.
 *
 * Medewerkerrechten gelden twaalf uur na het inloggen via Cloudflare
 * (`sessie_via_cloudflare()` in supabase/migrations). Daarna is de medewerker nog ingelogd,
 * maar geeft de database hem niets meer: zonder uitleg ziet hij lege schermen. Gebruik op een
 * scherm voor medewerkers:
 *
 *   const stand = useMedewerkersessie(session);
 *   if (stand === "verlopen") return <OpnieuwAlsMedewerker />;
 *   if (stand !== "medewerker") return <GeenToegang />;
 *
 * Dit is alleen uitleg voor de gebruiker. De grens zelf is de database: een scherm dat dit
 * overslaat, krijgt nog steeds niets.
 */
export type Medewerkersessie = "laden" | "medewerker" | "verlopen" | "geen";

/** Zo vaak kijkt een open scherm opnieuw of de rechten er nog zijn. */
export const OPNIEUW_KIJKEN_MS = 5 * 60 * 1000;

/** Begon deze sessie via een inlogdienst (`oauth` in het token)? Per mail is dat nooit zo. */
export function begonViaDienst(session: Pick<Session, "access_token"> | null): boolean {
  try {
    const deel = session?.access_token.split(".")[1] ?? "";
    const tekst = atob(deel.replaceAll("-", "+").replaceAll("_", "/"));
    const inhoud: unknown = JSON.parse(tekst);
    if (typeof inhoud !== "object" || inhoud === null || !("amr" in inhoud)) return false;
    const { amr } = inhoud;
    return (
      Array.isArray(amr) &&
      amr.some(
        (stap: unknown) =>
          typeof stap === "object" && stap !== null && "method" in stap && stap.method === "oauth",
      )
    );
  } catch {
    return false;
  }
}

/**
 * Wat de database zegt (`is_medewerker()`), met erbij hoe de sessie begon: begon hij via
 * Cloudflare en zegt de database nee, dan zijn de rechten verlopen.
 */
export function standVan(
  session: Pick<Session, "access_token"> | null,
  isMedewerker: boolean | null,
): Medewerkersessie {
  if (!session) return "geen";
  if (isMedewerker === null) return "laden";
  if (isMedewerker) return "medewerker";
  return begonViaDienst(session) ? "verlopen" : "geen";
}

export function useMedewerkersessie(session: Session | null): Medewerkersessie {
  const [isMedewerker, setIsMedewerker] = useState<boolean | null>(null);
  const token = session?.access_token;

  useEffect(() => {
    if (!token) {
      setIsMedewerker(null);
      return;
    }
    let actief = true;
    const kijk = async () => {
      const { data, error } = await supabase.rpc("is_medewerker");
      // Bij een storing blijft de laatste stand staan; de database beslist toch zelf.
      if (actief && !error) setIsMedewerker(data === true);
    };
    void kijk();
    const klok = window.setInterval(() => void kijk(), OPNIEUW_KIJKEN_MS);
    return () => {
      actief = false;
      window.clearInterval(klok);
    };
  }, [token]);

  return standVan(session, isMedewerker);
}

/** De melding met de knop: opnieuw inloggen via Cloudflare, zonder eerst uit te loggen. */
export function OpnieuwAlsMedewerker() {
  const [mislukt, setMislukt] = useState(false);

  async function opnieuw() {
    setMislukt(false);
    try {
      try {
        merkDienstInlog(window.sessionStorage, Date.now());
      } catch {
        // Geen opslag: na terugkomst is er dan één klik extra ("Verder naar de app").
      }
      await startInloggen("cloudflare", supabase.auth, {
        terugNaar: `${window.location.origin}/login`,
      });
    } catch {
      setMislukt(true);
    }
  }

  return (
    <div role="alert" className="flex flex-col gap-3 rounded-md border p-4 text-sm">
      <p className="font-medium">Log opnieuw in als medewerker</p>
      <p className="text-muted-foreground">
        Je inlog als medewerker is verlopen. Je bent nog wel ingelogd, maar ziet alleen wat een
        klant ziet tot je opnieuw inlogt.
      </p>
      <Button onClick={() => void opnieuw()}>Inloggen voor medewerkers</Button>
      {mislukt ? (
        <p className="text-destructive">
          Inloggen is niet gelukt. Probeer het opnieuw of vraag je beheerder.
        </p>
      ) : null}
    </div>
  );
}
