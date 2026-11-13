import type { Session } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Button, buttonVariants } from "@/components/ui/button";
import { startInloggen } from "@/features/auth/inlogdienst";
import { LoginPage } from "@/features/auth/login-page";
import {
  adresVingerafdruk,
  BEGIN,
  bewaar,
  foutUitAdres,
  isDienstInlogBegonnen,
  leesAanvraag,
  merkDienstInlog,
  wisAangevraagd,
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
  const [netIngelogd, setNetIngelogd] = useState<NetIngelogd | null>(null);
  const ingelogd = useCallback(() => {
    // De aanvraag van een code in deze browser (als die er is): het adres van het account
    // wordt ermee vergeleken, en daarna telt hij niet meer.
    const gedeeld = gedeeldeOpslag();
    const aanvraag = gedeeld ? leesAanvraag(gedeeld, Date.now()) : null;
    if (gedeeld) wisAangevraagd(gedeeld);
    setNetIngelogd({ aangevraagd: aanvraag?.adres ?? null });
  }, []);
  const meldingWeg = useCallback(() => setNetIngelogd(null), []);

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
        <IngelogdAls
          adres={session.user.email}
          aangevraagd={netIngelogd.aangevraagd}
          klaar={meldingWeg}
        />
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
/**
 * Na het inloggen staat bovenin op welk adres je binnen bent: bij een klantportaal, en bij
 * elke app waar je met een link uit de mail inlogt (een ander kan je zijn link sturen).
 */
const toonAdres = klantportaal || inlogdiensten.includes("mailcode");

type NetIngelogd = {
  /** De vingerafdruk van het adres waarop deze browser een code aanvroeg, of null. */
  aangevraagd: string | null;
};

function tabblad(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function gedeeldeOpslag(): Storage | null {
  try {
    return window.localStorage;
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
  const [begin] = useState(() => {
    const kluis = tabblad();
    const vanDienst = kluis !== null && isDienstInlogBegonnen(kluis, Date.now());
    // Terug van de knop voor medewerkers met een weigering, terwijl de mailsessie er nog
    // is: die weigering hoort in beeld, niet "gelukt".
    const weigering =
      klantportaal && vanDienst && session !== null
        ? foutUitAdres(window.location.search, window.location.hash, true)
        : null;
    return {
      wasAlBinnen: klantportaal && session !== null && (!vanDienst || weigering !== null),
      weigering,
    };
  });
  // Wie hier uitlogt en daarna (op deze pagina) opnieuw inlogt, was niet "al binnen".
  const [wasAlBinnen, setWasAlBinnen] = useState(begin.wasAlBinnen);
  useEffect(() => {
    if (!session) setWasAlBinnen(false);
  }, [session]);
  const klaar = session !== null && !wasAlBinnen;

  useEffect(() => {
    if (!begin.weigering) return;
    // De weigering staat nu in beeld: weg uit de adresbalk, en het tabblad is niet meer
    // "net naar de dienst".
    window.history.replaceState(null, "", window.location.pathname);
    const kluis = tabblad();
    if (kluis) wisDienstInlog(kluis);
  }, [begin.weigering]);

  useEffect(() => {
    if (!klaar) return;
    // Net ingelogd: het tabblad hoeft niets meer te onthouden over deze inlog.
    const kluis = tabblad();
    if (kluis) {
      wisDienstInlog(kluis);
      bewaar(kluis, BEGIN);
    }
    if (toonAdres) ingelogd();
  }, [klaar, ingelogd]);

  if (!session) return <LoginPage />;
  if (wasAlBinnen) {
    return (
      <AlIngelogd
        adres={session.user.email}
        weigering={begin.weigering ? (WEIGERING[begin.weigering.soort] ?? GEEN_TOEGANG) : null}
      />
    );
  }
  return <Navigate to="/" replace />;
}

const GEEN_TOEGANG =
  "Inloggen voor medewerkers is niet gelukt. Probeer het opnieuw of vraag je beheerder.";
/** De uitleg bij een weigering van de dienst; alleen een vaste tekst, nooit die uit het adres. */
const WEIGERING: Partial<Record<string, string>> = {
  "bevestig-adres":
    "Inloggen voor medewerkers is nog niet gelukt: je e-mailadres moet nog één keer bevestigd worden. Je hebt daarvoor een mail gekregen: klik op de link in die mail en kies daarna opnieuw Inloggen voor medewerkers.",
  "adres-bezet":
    "Inloggen voor medewerkers lukt nog niet: op dit e-mailadres bestaat al een account dat nog niet bevestigd is. Vraag je beheerder om dat account in Supabase te bevestigen of te verwijderen.",
};

function AlIngelogd({ adres, weigering }: { adres: string | undefined; weigering: string | null }) {
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
      {mislukt || weigering ? (
        <p role="alert" className="text-sm text-destructive">
          {mislukt
            ? "Inloggen is niet gelukt. Probeer het opnieuw of vraag je beheerder."
            : weigering}
        </p>
      ) : null}
      <Button variant="ghost" onClick={() => void supabase.auth.signOut()}>
        Uitloggen
      </Button>
    </main>
  );
}

/**
 * Na het inloggen: op welk adres ben je binnen? Wie via een link van een ander in het
 * verkeerde account terechtkomt, ziet het hier. De melding blijft staan tot je hem wegklikt of
 * naar een ander scherm gaat. Vroeg deze browser een code aan voor een ánder adres, dan staat
 * dat er met nadruk bij: een ander kan je eerst zelf een code laten aanvragen en je daarna de
 * link uit zíjn mail sturen.
 */
function IngelogdAls({
  adres,
  aangevraagd,
  klaar,
}: {
  adres: string | undefined;
  aangevraagd: string | null;
  klaar: () => void;
}) {
  const { pathname } = useLocation();
  const [pad, setPad] = useState<string | null>(null);
  const [anders, setAnders] = useState(false);

  useEffect(() => {
    // Het eerste scherm na /login is waar de melding hoort; een volgend scherm haalt hem weg.
    if (pathname === "/login") return;
    if (pad === null) setPad(pathname);
    else if (pathname !== pad) klaar();
  }, [pathname, pad, klaar]);

  useEffect(() => {
    if (!adres || aangevraagd === null) return;
    let actief = true;
    void adresVingerafdruk(adres).then((vinger) => {
      if (actief) setAnders(vinger !== aangevraagd);
    });
    return () => {
      actief = false;
    };
  }, [adres, aangevraagd]);

  if (!adres) return null;
  return (
    <div
      role="status"
      data-testid="ingelogd-als"
      className={cn(
        "flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-3 py-2 text-center text-sm",
        anders ? "bg-destructive/10 text-foreground" : "bg-muted text-foreground",
      )}
    >
      <p>
        Je bent ingelogd als <span className="font-medium">{adres}</span>.
      </p>
      {anders ? (
        <p data-testid="ingelogd-als-ander" className="font-medium text-destructive">
          Let op: dit is niet het adres waarvoor je in deze browser een code aanvroeg. Is dit niet
          jouw account, log dan meteen uit.
        </p>
      ) : null}
      <span className="flex gap-2">
        {anders ? (
          <Button size="sm" variant="outline" onClick={() => void supabase.auth.signOut()}>
            Uitloggen
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={klaar}>
          Sluiten
        </Button>
      </span>
    </div>
  );
}
