/**
 * De startpagina van een app zonder database. Dit is wat een verse app laat zien
 * totdat er iets gebouwd is: geen inlogscherm (er is niets om in te loggen), wel een
 * pagina die de bouwer vertelt hoe hij verder gaat. De browsertest voor deze stand
 * (e2e/start.spec.ts) kijkt naar de kop "Welkom".
 */
export function StartPage() {
  return (
    <main className="mx-auto max-w-xl p-6">
      <h1 className="text-2xl font-semibold">Welkom</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        Deze app draait, maar heeft nog geen inhoud. Open de map van de app in Claude Code, typ{" "}
        <code>/stagetwo-tier2:verder-werken</code> en beschrijf wat de app moet doen.
      </p>
    </main>
  );
}
