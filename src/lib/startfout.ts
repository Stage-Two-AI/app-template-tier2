/**
 * Een fout in de omgevingsvariabelen (lib/env.ts). `namen` zijn de namen van de variabelen die
 * niet kloppen, zonder hun waarde. De volledige uitleg (met de waarde en wat een ontwikkelaar
 * moet doen) staat in `message` en gaat alleen naar de console.
 *
 * Staat hier en niet in env.ts: main.tsx laadt dit bestand vóór de app, en env.ts gooit bij het
 * laden al een fout.
 */
export class Omgevingsfout extends Error {
  readonly namen: string[];

  constructor(bericht: string, namen: string[]) {
    super(bericht);
    this.name = "Omgevingsfout";
    this.namen = namen;
  }
}

/**
 * Kan de app niet starten (meestal: een omgevingsvariabele klopt niet, zie lib/env.ts), dan
 * staat dat op het scherm in plaats van een witte pagina. De tekst komt als tekst in de
 * pagina, nooit als HTML.
 *
 * Dit scherm kan iedereen op internet zien (bij een klantportaal staat er geen deur voor). Het
 * toont daarom nooit de waarde van een variabele of aanwijzingen voor ontwikkelaars, alleen de
 * namen van wat niet klopt; de volledige fout staat in de console van de browser.
 */
export function toonStartfout(fout: unknown, doel: HTMLElement | null = document.body): void {
  console.error(fout);
  if (!doel) return;
  const vak = document.createElement("main");
  vak.setAttribute("role", "alert");
  vak.style.cssText = "max-width:40rem;margin:0 auto;padding:1.5rem;font-family:sans-serif";
  const kop = document.createElement("h1");
  kop.textContent = "Deze app kan niet starten";
  kop.style.cssText = "font-size:1.25rem;font-weight:600";
  const uitleg = document.createElement("p");
  uitleg.textContent =
    fout instanceof Omgevingsfout && fout.namen.length > 0
      ? `De instellingen van deze versie kloppen niet (${fout.namen.join(", ")}). Wie de app beheert, vindt de details in de console van de browser.`
      : "Er ging iets mis bij het opstarten. Probeer het later opnieuw. Wie de app beheert, vindt de details in de console van de browser.";
  uitleg.style.cssText = "font-size:0.9rem";
  vak.append(kop, uitleg);
  doel.replaceChildren(vak);
}
