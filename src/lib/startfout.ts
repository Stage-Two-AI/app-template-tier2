/**
 * Kan de app niet starten (meestal: een omgevingsvariabele klopt niet, zie lib/env.ts), dan
 * staat dat op het scherm in plaats van een witte pagina. De tekst komt als tekst in de
 * pagina, nooit als HTML.
 */
export function toonStartfout(fout: unknown, doel: HTMLElement | null = document.body): void {
  if (!doel) return;
  const vak = document.createElement("main");
  vak.setAttribute("role", "alert");
  vak.style.cssText = "max-width:40rem;margin:0 auto;padding:1.5rem;font-family:sans-serif";
  const kop = document.createElement("h1");
  kop.textContent = "Deze app kan niet starten";
  kop.style.cssText = "font-size:1.25rem;font-weight:600";
  const uitleg = document.createElement("pre");
  uitleg.textContent = fout instanceof Error ? fout.message : String(fout);
  uitleg.style.cssText = "white-space:pre-wrap;font-family:inherit;font-size:0.9rem";
  vak.append(kop, uitleg);
  doel.replaceChildren(vak);
  console.error(fout);
}
