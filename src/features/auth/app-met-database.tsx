import type { Session } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { Button, buttonVariants } from "@/components/ui/button";
import { startInloggen } from "@/features/auth/inlogdienst";
import { LoginPage } from "@/features/auth/login-page";
import {
  BEGIN,
  bewaar,
  isDienstInlogBegonnen,
  merkDienstInlog,
  wisDienstInlog,
} from "@/features/auth/mailcode";
import { useSession } from "@/features/auth/use-session";
import { ItemsPage } from "@/features/items/items-page";
import { inlogdiensten } from "@/lib/env";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";

/**
 * Het deel van de app dat een database nodig heeft: inloggen en de voorbeeldlijst.
 * App.tsx laadt dit bestand alleen als de Supabase-waarden er zijn (zie
 * `heeftDatabase` in lib/env.ts), zodat een app zonder database nooit de
 * Supabase-client aanraakt.
 */
export default function AppMetDatabase() {
  const { session, loading } = useSession();
  const [netIngelogd, setNetIngelogd] = useState(false);
  const ingelogd = useCallback(() => setNetIngelogd(true), []);
  const meldingWeg = useCallback(() => setNetIngelogd(false), []);

  if (loading) {
    return (
      <p className="p-6 text-sm text-muted-foreground" role="status">
        Bezig met laden…
      </p>
    );
  }

  return (
    <>
      {session && netIngelogd ? (
        <IngelogdAls adres={session.user.email} klaar={meldingWeg} />
      ) : null}
      <Routes>
        <Route path="/login" element={<Inlogroute session={session} ingelogd={ingelogd} />} />
        <Route
          path="/"
          element={session ? <ItemsPage session={session} /> : <Navigate to="/login" replace />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}

/** Een klantportaal: meer dan één manier van inloggen, met Cloudflare voor medewerkers. */
const klantportaal = inlogdiensten.length > 1;
const medewerkersViaCloudflare = klantportaal && inlogdiensten.includes("cloudflare");

function tabblad(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * De route /login. Zonder sessie: de inlogpagina. Met een sessie: door naar de app, zoals
 * altijd.
 *
 * Eén uitzondering, alleen bij een klantportaal: wie al was ingelogd en zelf naar /login
 * gaat, krijgt de knop voor medewerkers te zien in plaats van meteen teruggestuurd te
 * worden. Zo komt een medewerker die per mail binnen is (of wiens twaalf uur om zijn) bij
 * die knop zonder eerst uit te loggen. "Al ingelogd" is: er was een sessie toen deze route
 * opende, en dit tabblad kwam niet net terug van de inlogdienst.
 */
function Inlogroute({ session, ingelogd }: { session: Session | null; ingelogd: () => void }) {
  const [wasAlBinnen] = useState(() => {
    const kluis = tabblad();
    const vanDienst = kluis !== null && isDienstInlogBegonnen(kluis, Date.now());
    return klantportaal && session !== null && !vanDienst;
  });
  const klaar = session !== null && !wasAlBinnen;

  useEffect(() => {
    if (!klaar) return;
    // Net ingelogd: het tabblad hoeft niets meer te onthouden over deze inlog.
    const kluis = tabblad();
    if (kluis) {
      wisDienstInlog(kluis);
      bewaar(kluis, BEGIN);
    }
    if (klantportaal) ingelogd();
  }, [klaar, ingelogd]);

  if (!session) return <LoginPage />;
  if (wasAlBinnen) return <AlIngelogd adres={session.user.email} />;
  return <Navigate to="/" replace />;
}

function AlIngelogd({ adres }: { adres: string | undefined }) {
  const [mislukt, setMislukt] = useState(false);

  async function alsMedewerker() {
    setMislukt(false);
    try {
      const kluis = tabblad();
      if (kluis) merkDienstInlog(kluis, Date.now());
      await startInloggen("cloudflare", supabase.auth, {
        terugNaar: `${window.location.origin}/login`,
      });
    } catch {
      setMislukt(true);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-5 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Je bent al ingelogd</h1>
      <p className="text-sm text-muted-foreground">
        Je bent ingelogd als <span className="font-medium text-foreground">{adres}</span>.
      </p>
      <Link to="/" className={cn(buttonVariants({ size: "lg" }), "h-12 text-base")}>
        Verder naar de app
      </Link>
      {medewerkersViaCloudflare ? (
        <Button
          variant="outline"
          size="lg"
          className="h-12 text-base"
          onClick={() => void alsMedewerker()}
        >
          Inloggen voor medewerkers
        </Button>
      ) : null}
      {mislukt ? (
        <p role="alert" className="text-sm text-destructive">
          Inloggen is niet gelukt. Probeer het opnieuw of vraag je beheerder.
        </p>
      ) : null}
      <Button variant="ghost" onClick={() => void supabase.auth.signOut()}>
        Uitloggen
      </Button>
    </main>
  );
}

/** Zo lang staat na het inloggen bovenin op welk adres je bent ingelogd. */
export const INGELOGD_ALS_MS = 10_000;

/**
 * Kort na het inloggen bij een klantportaal: op welk adres ben je binnen? Wie via een link
 * van een ander in het verkeerde account terechtkomt, ziet het hier meteen.
 */
function IngelogdAls({ adres, klaar }: { adres: string | undefined; klaar: () => void }) {
  useEffect(() => {
    const klok = window.setTimeout(klaar, INGELOGD_ALS_MS);
    return () => window.clearTimeout(klok);
  }, [klaar]);

  if (!adres) return null;
  return (
    <p
      role="status"
      data-testid="ingelogd-als"
      className="bg-muted px-3 py-2 text-center text-sm text-foreground"
    >
      Je bent ingelogd als <span className="font-medium">{adres}</span>.
    </p>
  );
}
