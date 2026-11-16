import type { Session } from "@supabase/supabase-js";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { begonViaDienst, OpnieuwAlsMedewerker } from "@/features/auth/medewerkersessie";
import { WachtOpGoedkeuring } from "@/features/auth/wacht-op-goedkeuring";
import { supabase } from "@/lib/supabase";

/**
 * Voorbeeld voor een klantportaal (docs/routes/klantportaal.md): de omhulling om elke route
 * van de app behalve /login. Hij vraagt de database wie er binnen is:
 *
 * - een medewerker (ingelogd via Cloudflare, hoogstens twaalf uur geleden): de app;
 * - via Cloudflare binnen, maar de twaalf uur zijn om: de knop om opnieuw in te loggen als
 *   medewerker (anders kwam een medewerker als klant op de wachtlijst);
 * - iedereen anders meldt zich aan als klant (`klant_aanmelden()`, niet goedgekeurd) en ziet,
 *   tot een medewerker hem goedkeurt, het scherm uit wacht-op-goedkeuring.tsx;
 * - een goedgekeurde klant: de app.
 *
 * Het makkelijkst als omhulling om alle routes van de app behalve /login, met `PortaalRoute`
 * (hieronder) als route zonder pad. Geneste routes en de vangroute vallen er dan vanzelf onder,
 * en de routes zelf blijven zoals ze waren.
 *
 * Dit is alleen wat de gebruiker te zien krijgt. De grens zelf is de database: een scherm
 * zonder deze omhulling krijgt nog steeds niets.
 *
 * De template gebruikt dit zelf niet (de template is geen klantportaal).
 */
export type Toegang = "medewerker" | "klant" | "wacht" | "verlopen" | "fout";

/** Wat de database over deze sessie zegt. Een nieuw account meldt zich aan als klant. */
export async function bepaalToegang(session: Session): Promise<Toegang> {
  const medewerker = await supabase.rpc("is_medewerker");
  if (medewerker.error) return "fout";
  if (medewerker.data === true) return "medewerker";
  // Via Cloudflare binnen, maar de twaalf uur zijn om: opnieuw inloggen, geen klant.
  if (begonViaDienst(session)) return "verlopen";
  const aanmelden = await supabase.rpc("klant_aanmelden");
  if (aanmelden.error) return "fout";
  const klant = await supabase.rpc("is_goedgekeurde_klant");
  if (klant.error) return "fout";
  return klant.data === true ? "klant" : "wacht";
}

export function Portaaltoegang({ session, children }: { session: Session; children: ReactNode }) {
  const [toegang, setToegang] = useState<Toegang | null>(null);
  const [beurt, setBeurt] = useState(0);
  const opnieuw = useCallback(() => setBeurt((n) => n + 1), []);

  useEffect(() => {
    // `beurt` telt alleen de klikken op "Opnieuw kijken"; elke klik vraagt het opnieuw.
    void beurt;
    let actief = true;
    bepaalToegang(session).then(
      (uitkomst) => {
        if (actief) setToegang(uitkomst);
      },
      () => {
        if (actief) setToegang("fout");
      },
    );
    return () => {
      actief = false;
    };
  }, [session, beurt]);

  if (toegang === null) {
    return (
      <p className="p-6 text-sm text-muted-foreground" role="status">
        Bezig met laden…
      </p>
    );
  }
  if (toegang === "verlopen") {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-5 py-10">
        <OpnieuwAlsMedewerker />
      </main>
    );
  }
  if (toegang === "wacht") {
    return <WachtOpGoedkeuring adres={session.user.email} opnieuw={opnieuw} />;
  }
  if (toegang === "fout") {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-5 py-10">
        <p role="alert" className="text-sm text-destructive">
          Het lukte niet om na te gaan wat je mag zien. Controleer je verbinding en probeer het
          opnieuw.
        </p>
        <Button onClick={opnieuw}>Opnieuw proberen</Button>
      </main>
    );
  }
  return <>{children}</>;
}

/**
 * `Portaaltoegang` als route zonder pad, om alle routes van de app behalve /login heen. Zonder
 * sessie doet hij niets: de routes eronder sturen dan zelf door naar /login.
 */
export function PortaalRoute({ session }: { session: Session | null }) {
  if (!session) return <Outlet />;
  return (
    <Portaaltoegang session={session}>
      <Outlet />
    </Portaaltoegang>
  );
}
