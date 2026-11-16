import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type InlogAuth, type Inlogdienst, startInloggen } from "@/features/auth/inlogdienst";
import {
  CODE_LENGTE,
  isFoutVanDienst,
  isHeleCode,
  leesCode,
  type MailcodeAuth,
  merkDienstInlog,
} from "@/features/auth/mailcode";
import { type Robotcontrole, useRobotcontrole } from "@/features/auth/robotcontrole";
import { useMailcode } from "@/features/auth/use-mailcode";

/**
 * De inlogpagina van een klantportaal: klanten vullen hun e-mailadres in en krijgen een
 * code van tien cijfers, medewerkers loggen in via Cloudflare. Deze component tekent alleen;
 * de stappen en regels staan in mailcode.ts.
 *
 * Deze pagina staat open voor iedereen en geeft niemand rechten: dat doet de database.
 */
const KNOPTEKST: Record<Exclude<Inlogdienst, "mailcode" | "wachtwoord">, string> = {
  cloudflare: "Inloggen voor medewerkers",
  azure: "Inloggen met Microsoft",
  google: "Inloggen met Google",
};

type Knopdienst = keyof typeof KNOPTEKST;

function isKnopdienst(dienst: Inlogdienst): dienst is Knopdienst {
  return dienst in KNOPTEKST;
}

/**
 * De naam van de app, boven het formulier: wie via een link uit een mail binnenkomt, ziet zo
 * meteen bij wie hij inlogt. Het is de titel van de pagina (`<title>` in index.html), dus er
 * hoeft niets apart ingesteld te worden.
 */
function merknaam(): string {
  return document.title.trim();
}

function Pagina({ kop, children }: { kop: string; children: ReactNode }) {
  const merk = merknaam();
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-5 py-10">
      {merk ? (
        <p data-testid="merknaam" className="pb-4 text-center text-xl font-semibold tracking-tight">
          {merk}
        </p>
      ) : null}
      <h1 className="text-2xl font-semibold tracking-tight">{kop}</h1>
      {children}
    </main>
  );
}

function Melding({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="text-sm text-destructive">
      {children}
    </p>
  );
}

export function InlogMetCode({
  diensten,
  auth,
  terugNaar,
  robotSleutel,
}: {
  diensten: readonly Inlogdienst[];
  auth: MailcodeAuth & InlogAuth;
  terugNaar: () => string;
  /** De sitekey van Turnstile; leeg of afwezig is uit. Zie robotcontrole.ts. */
  robotSleutel?: string;
}) {
  const metMail = diensten.includes("mailcode");
  const knoppen = diensten.filter(isKnopdienst);
  const robot = useRobotcontrole(metMail ? robotSleutel : undefined);
  const mailcode = useMailcode(auth, terugNaar, robot);
  const { toestand } = mailcode;
  // Een weigering na de knop voor medewerkers gaat niet over het adresveld van de klant.
  const vanDienst = toestand.fout !== null && isFoutVanDienst(toestand.fout.soort);

  if (toestand.stap === "link") return <LinkStap mailcode={mailcode} />;
  if (metMail && toestand.stap === "code") return <CodeStap mailcode={mailcode} robot={robot} />;

  return (
    <Pagina kop="Inloggen">
      {toestand.fout && (vanDienst || !metMail) ? <Melding>{toestand.fout.tekst}</Melding> : null}
      {metMail ? <AdresStap mailcode={mailcode} robot={robot} toonFout={!vanDienst} /> : null}
      {metMail && knoppen.includes("cloudflare") ? (
        // Supabase kent één account per adres. Een medewerker die hier zijn werkadres invult,
        // maakt een klantaccount op dat adres en loopt daarna vast bij de knop.
        <p className="text-sm text-muted-foreground">
          Werk je hier? Gebruik de knop Inloggen voor medewerkers.
        </p>
      ) : null}
      {metMail && knoppen.length > 0 ? (
        <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden="true">
          <span className="h-px flex-1 bg-border" />
          of
          <span className="h-px flex-1 bg-border" />
        </div>
      ) : null}
      {knoppen.length > 0 ? (
        <Dienstknoppen diensten={knoppen} auth={auth} terugNaar={terugNaar} />
      ) : null}
    </Pagina>
  );
}

type StapProps = { mailcode: ReturnType<typeof useMailcode> };
type MetRobot = StapProps & { robot: Robotcontrole | null };

/** Hier zet Turnstile zijn widget neer. Meestal blijft het vak leeg en onzichtbaar. */
function Robotvak({ robot }: { robot: Robotcontrole | null }) {
  return robot ? (
    <div ref={robot.vak} data-testid="robotcontrole" className="empty:hidden" />
  ) : null;
}

function AdresStap({ mailcode, robot, toonFout }: MetRobot & { toonFout: boolean }) {
  const { toestand } = mailcode;
  const fout = toonFout ? toestand.fout : null;
  const [adres, setAdres] = useState(toestand.email);
  const veld = useRef<HTMLInputElement>(null);
  const bezig = toestand.bezig !== null;

  useEffect(() => {
    // Bij een fout terug naar het veld, zodat een schermlezer en het toetsenbord daar staan.
    if (fout) veld.current?.focus();
  }, [fout]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!bezig) void mailcode.verstuur(adres);
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
      <p className="text-sm text-muted-foreground">
        Vul je e-mailadres in. Je krijgt een mail met een code van tien cijfers.
      </p>
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">E-mailadres</Label>
        <Input
          ref={veld}
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          className="h-12 text-base"
          value={adres}
          aria-invalid={fout?.soort === "adres" ? true : undefined}
          aria-describedby={fout ? "email-fout" : undefined}
          onChange={(event) => setAdres(event.target.value)}
        />
      </div>
      {fout ? <Melding id="email-fout">{fout.tekst}</Melding> : null}
      <Robotvak robot={robot} />
      <Button type="submit" size="lg" className="h-12 text-base" disabled={bezig}>
        {bezig ? "Bezig…" : "Doorgaan"}
      </Button>
    </form>
  );
}

function CodeStap({ mailcode, robot }: MetRobot) {
  const { toestand, wachtNog } = mailcode;
  const [code, setCode] = useState("");
  const veld = useRef<HTMLInputElement>(null);
  const controleren = toestand.bezig === "controleren";
  const bezig = toestand.bezig !== null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: opnieuw focussen bij elke nieuwe fout of melding
  useEffect(() => {
    veld.current?.focus();
  }, [toestand.fout, toestand.melding]);

  function wijzig(invoer: string) {
    const nieuw = leesCode(invoer);
    setCode(nieuw);
    // Tien cijfers getypt of geplakt (of door de telefoon ingevuld): meteen controleren.
    if (isHeleCode(nieuw) && nieuw !== code && !bezig) void mailcode.controleer(nieuw);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!bezig) void mailcode.controleer(code);
  }

  return (
    <Pagina kop="Vul de code in">
      <p className="text-sm text-muted-foreground">
        Verstuurd naar <span className="font-medium text-foreground">{toestand.email}</span>. De
        code is een kwartier geldig. Je kunt ook op de link in de mail klikken.
      </p>
      <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        <div className="flex flex-col gap-2">
          <Label htmlFor="code">Code van tien cijfers</Label>
          <Input
            ref={veld}
            id="code"
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            required
            className="h-14 text-center font-mono text-2xl tracking-[0.25em]"
            placeholder={"•".repeat(CODE_LENGTE)}
            value={code}
            aria-invalid={toestand.fout ? true : undefined}
            aria-describedby={toestand.fout ? "code-fout" : undefined}
            onChange={(event) => wijzig(event.target.value)}
          />
        </div>
        {toestand.fout ? <Melding id="code-fout">{toestand.fout.tekst}</Melding> : null}
        {toestand.melding ? (
          <p role="status" className="text-sm text-muted-foreground">
            {toestand.melding}
          </p>
        ) : null}
        <Button type="submit" size="lg" className="h-12 text-base" disabled={bezig}>
          {controleren ? "Bezig…" : "Inloggen"}
        </Button>
      </form>
      {/* Voor "Stuur een nieuwe code": ook die aanvraag heeft een bewijs nodig. */}
      <Robotvak robot={robot} />
      <div className="flex flex-col gap-1 text-sm">
        <p className="text-muted-foreground">Geen mail gekregen? Kijk ook bij ongewenste mail.</p>
        <div className="flex flex-wrap justify-between gap-x-4">
          <Button
            variant="ghost"
            className="h-11 px-0 text-primary underline-offset-4 hover:bg-transparent hover:underline"
            disabled={bezig || wachtNog > 0}
            onClick={() => void mailcode.opnieuw()}
          >
            {toestand.bezig === "opnieuw"
              ? "Bezig…"
              : wachtNog > 0
                ? `Nieuwe code kan over ${wachtNog} s`
                : "Stuur een nieuwe code"}
          </Button>
          <Button
            variant="ghost"
            className="h-11 px-0 text-primary underline-offset-4 hover:bg-transparent hover:underline"
            disabled={bezig}
            onClick={mailcode.anderAdres}
          >
            Ander e-mailadres
          </Button>
        </div>
      </div>
    </Pagina>
  );
}

/**
 * Binnengekomen via de link uit de mail. Pas na een klik wordt de link verzilverd: een
 * mailprogramma of virusscanner die links vooraf opent, verbruikt hem zo niet.
 */
function LinkStap({ mailcode }: StapProps) {
  const bezig = mailcode.toestand.bezig !== null;
  return (
    <Pagina kop="Inloggen">
      {mailcode.linkHierAangevraagd ? (
        <p className="text-sm text-muted-foreground">
          Je bent er bijna. Klik op de knop om in te loggen.
        </p>
      ) : (
        // De mail is niet in deze browser aangevraagd. Meestal is dat onschuldig (de link
        // opent in de browser van het mailprogramma), maar een ander kan je ook zíjn link
        // sturen: dan log je in op zijn account en ziet hij wat je daar invult.
        <div
          data-testid="link-waarschuwing"
          className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
        >
          <p className="font-medium">Heb je deze mail zelf aangevraagd?</p>
          <p>
            Log alleen in als je zojuist zelf om deze inlogmail hebt gevraagd. Kreeg je de link van
            iemand anders, dan kom je in het account van die ander: sluit dan deze pagina.
          </p>
        </div>
      )}
      <Button
        size="lg"
        className="h-12 text-base"
        disabled={bezig}
        onClick={() => void mailcode.bevestigLink()}
      >
        {bezig ? "Bezig…" : "Inloggen"}
      </Button>
    </Pagina>
  );
}

function Dienstknoppen({
  diensten,
  auth,
  terugNaar,
}: {
  diensten: Knopdienst[];
  auth: InlogAuth;
  terugNaar: () => string;
}) {
  const [bezig, setBezig] = useState<Knopdienst | null>(null);
  const [mislukt, setMislukt] = useState(false);

  async function inloggen(dienst: Knopdienst) {
    setMislukt(false);
    setBezig(dienst);
    try {
      // Onthoud dat dit tabblad zelf naar de dienst ging; zie merkDienstInlog in mailcode.ts.
      try {
        merkDienstInlog(window.sessionStorage, Date.now());
      } catch {
        // Geen opslag: de pagina toont bij terugkomst dan de neutrale melding.
      }
      await startInloggen(dienst, auth, { terugNaar: terugNaar() });
    } catch {
      setMislukt(true);
      setBezig(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {diensten.map((dienst) => (
        <Button
          key={dienst}
          variant="outline"
          size="lg"
          className="h-12 text-base"
          disabled={bezig !== null}
          onClick={() => void inloggen(dienst)}
        >
          {bezig === dienst ? "Bezig…" : KNOPTEKST[dienst]}
        </Button>
      ))}
      {mislukt ? (
        <Melding>Inloggen is niet gelukt. Probeer het opnieuw of vraag je beheerder.</Melding>
      ) : null}
    </div>
  );
}
