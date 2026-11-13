import type { Session } from "@supabase/supabase-js";
import type { ReactNode } from "react";
import { OpnieuwAlsMedewerker, useMedewerkersessie } from "@/features/auth/medewerkersessie";

/**
 * Voorbeeld voor een klantportaal (docs/routes/klantportaal.md): een scherm of een deel van een
 * scherm alleen voor medewerkers. De inhoud verschijnt alleen bij een verse medewerkersessie
 * (ingelogd via Cloudflare, hoogstens twaalf uur geleden). Zijn die twaalf uur om, dan de
 * melding met de knop om opnieuw in te loggen als medewerker; een klant ziet "Geen toegang".
 *
 *   <AlleenMedewerker session={session}>
 *     <KlantenGoedkeuren />
 *   </AlleenMedewerker>
 *
 * Dit is alleen wat de gebruiker te zien krijgt. De grens zelf is de database: een tabel voor
 * medewerkers heeft de policy `using ((select public.is_medewerker()))`.
 *
 * De template gebruikt dit zelf niet (de template is geen klantportaal).
 */
export function AlleenMedewerker({
  session,
  children,
}: {
  session: Session | null;
  children: ReactNode;
}) {
  const stand = useMedewerkersessie(session);
  if (stand === "medewerker") return <>{children}</>;
  if (stand === "laden") {
    return (
      <p className="p-6 text-sm text-muted-foreground" role="status">
        Bezig met laden…
      </p>
    );
  }
  if (stand === "verlopen") return <OpnieuwAlsMedewerker />;
  return <GeenToegang />;
}

/** Voor wie geen medewerker is: een klant, of iemand die per mail is ingelogd. */
export function GeenToegang() {
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-md border p-4 text-sm">
      <p className="font-medium">Geen toegang</p>
      <p className="text-muted-foreground">
        Dit deel van de app is alleen voor medewerkers. Ben je medewerker, log dan in met de knop
        voor medewerkers op de inlogpagina.
      </p>
    </div>
  );
}
