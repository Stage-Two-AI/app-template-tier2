import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type Inlogdienst, inlogVorm, startInloggen } from "@/features/auth/inlogdienst";
import { env, testloginVoorDev } from "@/lib/env";
import { supabase } from "@/lib/supabase";
import { credentialsSchema, fieldErrors } from "@/lib/validation";

const KNOPTEKST: Partial<Record<Inlogdienst, string>> = {
  azure: "Inloggen met Microsoft",
  google: "Inloggen met Google",
};

/**
 * Waar de inlogdienst de gebruiker naar terugstuurt: de inlogpagina zelf. Na een
 * geslaagde login stuurt die door naar de startpagina. Na een weigering blijft de fout
 * in het adres staan en toont deze pagina hem; via `/` zou de doorverwijzing naar
 * `/login` de fout uit het adres halen en begon het inloggen opnieuw, eindeloos.
 */
function terugNaar(): string {
  return `${window.location.origin}/login`;
}

/**
 * Kwam Supabase terug met een fout (bijvoorbeeld: geen toegang)? Dan staat die in het
 * adres. In dat geval sturen we niet opnieuw door, anders ontstaat een eindeloze lus.
 */
function foutUitAdres(): string | null {
  const params = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const fout = params.get("error_description") ?? hash.get("error_description");
  if (fout) return fout;
  return params.get("error") ?? hash.get("error");
}

export function LoginPage({
  dienst = env.VITE_INLOGDIENST,
  testlogin = testloginVoorDev(),
}: {
  dienst?: Inlogdienst;
  /** Alleen lokaal in de dev-server: de testgebruiker van de testdatabase (`pnpm testlogin`). */
  testlogin?: { email: string; wachtwoord: string } | null;
}) {
  const vorm = inlogVorm(dienst);
  if (vorm === "wachtwoord") return <WachtwoordFormulier testlogin={testlogin} />;
  if (vorm === "mailcode") return <MailcodeFormulier />;
  return <ExterneInlog dienst={dienst} automatisch={vorm === "doorsturen"} />;
}

function Pagina({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">Inloggen</h1>
      {children}
    </main>
  );
}

function ExterneInlog({ dienst, automatisch }: { dienst: Inlogdienst; automatisch: boolean }) {
  const [fout, setFout] = useState<string | null>(() => foutUitAdres());
  const [bezig, setBezig] = useState(false);
  const gestart = useRef(false);

  const inloggen = useCallback(async () => {
    setFout(null);
    setBezig(true);
    try {
      await startInloggen(dienst, supabase.auth, { terugNaar: terugNaar() });
    } catch {
      setFout("Inloggen is niet gelukt. Probeer het opnieuw of vraag je beheerder om toegang.");
      setBezig(false);
    }
  }, [dienst]);

  useEffect(() => {
    // Eén keer automatisch doorsturen, en alleen als er geen fout terugkwam.
    if (!automatisch || gestart.current || foutUitAdres()) return;
    gestart.current = true;
    void inloggen();
  }, [automatisch, inloggen]);

  if (fout) {
    return (
      <Pagina>
        <p role="alert" className="text-sm text-destructive">
          {fout}
        </p>
        <Button onClick={() => void inloggen()}>Opnieuw proberen</Button>
      </Pagina>
    );
  }

  if (automatisch) {
    return (
      <Pagina>
        <p role="status" className="text-sm text-muted-foreground">
          Je wordt doorgestuurd om in te loggen…
        </p>
      </Pagina>
    );
  }

  return (
    <Pagina>
      <Button onClick={() => void inloggen()} disabled={bezig}>
        {bezig ? "Bezig…" : (KNOPTEKST[dienst] ?? "Inloggen")}
      </Button>
    </Pagina>
  );
}

function MailcodeFormulier() {
  const [email, setEmail] = useState("");
  const [fout, setFout] = useState<string | null>(null);
  const [verstuurd, setVerstuurd] = useState(false);
  const [bezig, setBezig] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFout(null);
    const adres = credentialsSchema.shape.email.safeParse(email);
    if (!adres.success) {
      setFout(adres.error.issues[0]?.message ?? "Dit lijkt geen geldig e-mailadres.");
      return;
    }
    setBezig(true);
    try {
      await startInloggen("mailcode", supabase.auth, {
        terugNaar: terugNaar(),
        email: adres.data,
      });
      setVerstuurd(true);
    } catch {
      setFout("Er ging iets mis bij het versturen. Controleer je e-mailadres.");
    }
    setBezig(false);
  }

  if (verstuurd) {
    return (
      <Pagina>
        <p role="status" className="text-sm">
          Kijk in je mail: daar staat een link om in te loggen.
        </p>
      </Pagina>
    );
  }

  return (
    <Pagina>
      <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">E-mailadres</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        {fout ? (
          <p role="alert" className="text-sm text-destructive">
            {fout}
          </p>
        ) : null}
        <Button type="submit" disabled={bezig}>
          {bezig ? "Bezig…" : "Stuur inloglink"}
        </Button>
      </form>
    </Pagina>
  );
}

function WachtwoordFormulier({
  testlogin,
}: {
  testlogin: { email: string; wachtwoord: string } | null;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Lokaal, met de testdatabase: één klik en je bent binnen als de testgebruiker. Zo kan
   * ook Claude in de preview rondklikken met echte gegevens, zonder Cloudflare. In een
   * gebouwde versie is er nooit een testlogin (zie testloginVoorDev).
   */
  async function alsTestgebruiker() {
    if (!testlogin) return;
    setFormError(null);
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({
      email: testlogin.email,
      password: testlogin.wachtwoord,
    });
    setBusy(false);
    if (error) {
      setFormError(
        "Inloggen als testgebruiker is niet gelukt. Haal een nieuwe testlogin op met `pnpm testlogin`.",
      );
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const parsed = credentialsSchema.safeParse({ email, password });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setBusy(true);

    const { error } = await supabase.auth.signInWithPassword(parsed.data);
    setBusy(false);
    if (error) {
      setFormError("Inloggen is niet gelukt. Controleer je e-mailadres en wachtwoord.");
    }
  }

  return (
    <Pagina>
      {testlogin ? (
        <div className="flex flex-col gap-2 rounded-md border border-dashed p-4">
          <Button type="button" onClick={() => void alsTestgebruiker()} disabled={busy}>
            Inloggen als testgebruiker
          </Button>
          <p className="text-xs text-muted-foreground">
            Alleen op deze computer, met de testdatabase: {testlogin.email}
          </p>
        </div>
      ) : null}
      <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">E-mailadres</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          {errors.email ? <p className="text-sm text-destructive">{errors.email}</p> : null}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="password">Wachtwoord</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {errors.password ? <p className="text-sm text-destructive">{errors.password}</p> : null}
        </div>

        {formError ? (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        ) : null}

        <Button type="submit" disabled={busy}>
          {busy ? "Bezig…" : "Inloggen"}
        </Button>
      </form>
    </Pagina>
  );
}
