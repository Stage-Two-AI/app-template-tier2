import type { Session } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { AlleenMedewerker } from "@/features/auth/alleen-medewerker";
import type { Database } from "@/lib/database.types";
import { supabase } from "@/lib/supabase";

/**
 * Voorbeeld voor een klantportaal (docs/routes/klantportaal.md): het scherm waarop een
 * medewerker nieuwe klanten goedkeurt, of een goedkeuring weer intrekt. Een klant meldt zich
 * aan bij zijn eerste inlog (portaaltoegang.tsx); tot hij hier is goedgekeurd, krijgt hij niets.
 *
 * Wie wat mag, beslist de database: alleen een medewerker leest de tabel `klanten` en wijzigt
 * er de kolom `goedgekeurd` van. Dit scherm laat een klant daarom niets zien
 * (`AlleenMedewerker`), en zegt het als de database een wijziging weigert.
 *
 * De template gebruikt dit scherm zelf niet (de template is geen klantportaal). Een app geeft
 * het een eigen pad, en zet dat pad in GEEN_ONDERDEEL in src/onderdelen.ts: de browsertest
 * logt in als klant en kan dit scherm niet zien.
 */
type Klant = Pick<
  Database["public"]["Tables"]["klanten"]["Row"],
  "user_id" | "e_mail" | "goedgekeurd" | "aangemeld_op"
>;

export function KlantenGoedkeurenPage({ session }: { session: Session }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Klanten goedkeuren</h1>
      <AlleenMedewerker session={session}>
        <KlantenLijst />
      </AlleenMedewerker>
    </main>
  );
}

const datum = new Intl.DateTimeFormat("nl-NL", { dateStyle: "medium", timeStyle: "short" });

export function KlantenLijst() {
  const [klanten, setKlanten] = useState<Klant[]>([]);
  const [fout, setFout] = useState<string | null>(null);
  const [laden, setLaden] = useState(true);
  const [bezig, setBezig] = useState<string | null>(null);

  const laad = useCallback(async () => {
    const { data, error } = await supabase
      .from("klanten")
      .select("user_id, e_mail, goedgekeurd, aangemeld_op")
      .order("aangemeld_op", { ascending: false });
    if (error) {
      setFout("De lijst met klanten kon niet geladen worden.");
    } else {
      setKlanten(data);
      setFout(null);
    }
    setLaden(false);
  }, []);

  useEffect(() => {
    void laad();
  }, [laad]);

  async function zet(klant: Klant, goedgekeurd: boolean) {
    setBezig(klant.user_id);
    const { data, error } = await supabase
      .from("klanten")
      .update({ goedgekeurd })
      .eq("user_id", klant.user_id)
      .select("user_id");
    setBezig(null);
    // Weigert de database (bijvoorbeeld: je twaalf uur als medewerker zijn net om), dan komt er
    // geen fout maar een lege lijst terug.
    if (error || data.length === 0) {
      setFout(`Het lukte niet om ${klant.e_mail} te wijzigen. Probeer het opnieuw.`);
      return;
    }
    setFout(null);
    await laad();
  }

  if (laden) return <p className="text-sm text-muted-foreground">Bezig met laden…</p>;

  return (
    <div className="flex flex-col gap-4">
      {fout ? (
        <p role="alert" className="text-sm text-destructive">
          {fout}
        </p>
      ) : null}
      <ul className="flex flex-col gap-2" aria-label="Klanten">
        {klanten.map((klant) => (
          <li
            key={klant.user_id}
            className="flex items-center justify-between gap-4 rounded-md border bg-card p-3 text-sm"
          >
            <div className="flex flex-col">
              <span className="font-medium">{klant.e_mail}</span>
              <span className="text-muted-foreground">
                {klant.goedgekeurd ? "Goedgekeurd" : "Wacht op goedkeuring"}, aangemeld{" "}
                {datum.format(new Date(klant.aangemeld_op))}
              </span>
            </div>
            {klant.goedgekeurd ? (
              <Button
                variant="outline"
                size="sm"
                disabled={bezig === klant.user_id}
                onClick={() => void zet(klant, false)}
              >
                Intrekken
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={bezig === klant.user_id}
                onClick={() => void zet(klant, true)}
              >
                Goedkeuren
              </Button>
            )}
          </li>
        ))}
        {klanten.length === 0 ? (
          <li className="text-sm text-muted-foreground">Er heeft zich nog niemand aangemeld.</li>
        ) : null}
      </ul>
    </div>
  );
}
