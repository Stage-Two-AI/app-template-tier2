import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";

/**
 * Voorbeeld voor een klantportaal (docs/routes/klantportaal.md): het scherm voor een klant die
 * zich heeft aangemeld maar nog niet is goedgekeurd. Een medewerker keurt hem goed op het
 * scherm uit klanten-goedkeuren.tsx. Tot dan geeft de database hem niets; dit scherm zegt
 * alleen waarom. `Portaaltoegang` (portaaltoegang.tsx) toont het.
 *
 * De template gebruikt dit scherm zelf niet (de template is geen klantportaal). Een app neemt
 * het over via de route, en mag de teksten aanpassen.
 */
export function WachtOpGoedkeuring({
  adres,
  opnieuw,
}: {
  adres: string | undefined;
  /** Vraag de database opnieuw of het account al is goedgekeurd. */
  opnieuw?: () => void;
}) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-5 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Je account wacht op goedkeuring</h1>
      <p className="text-sm text-muted-foreground">
        Je bent ingelogd als <span className="font-medium text-foreground">{adres}</span>. Een
        medewerker bekijkt je aanmelding. Zodra die je goedkeurt, kun je verder; je hoeft daarvoor
        niet opnieuw in te loggen.
      </p>
      {opnieuw ? (
        <Button variant="outline" size="lg" className="h-12 text-base" onClick={opnieuw}>
          Opnieuw kijken
        </Button>
      ) : null}
      <Button variant="ghost" onClick={() => void supabase.auth.signOut()}>
        Uitloggen
      </Button>
    </main>
  );
}
