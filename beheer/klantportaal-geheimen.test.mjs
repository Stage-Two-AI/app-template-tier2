/**
 * Klantportaal, de geheimen: het SMTP-wachtwoord, het Turnstile-geheim en de service-sleutel
 * komen nooit in de uitvoer, het resultaat van een droogloop of een foutmelding, ook niet een
 * stuk ervan.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { richtIn, uitvoerRegel, werkToegangBij } from "./inrichten-cloudflare.mjs";
import { ARG, auth, DEUR, opzet, PORTAAL, SMTP, TURNSTILE } from "./klantportaal-opzet.mjs";
import { vraag } from "./lib/vraag.mjs";
import { nepWolk } from "./nep-wolk.mjs";

/** Een nep-wolk waarvan PATCH config/auth faalt met een antwoord naar keuze. */
function metAuthFout(basis, maakAntwoord) {
  return {
    ...basis,
    fetchFn: async (url, opties = {}) => {
      if ((opties.method ?? "GET") === "PATCH" && String(url).endsWith("/config/auth")) {
        const tekst = maakAntwoord(String(opties.body));
        return { ok: false, status: 400, statusText: "Bad Request", text: async () => tekst };
      }
      return basis.fetchFn(url, opties);
    },
  };
}

test("geheimen: kaatst Supabase de body terug in een fout die geen JSON is, dan staat er geen letter van het SMTP-wachtwoord in de melding", async () => {
  const basis = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(basis, DEUR));
  // Elke plek waar een afkapping midden in het geheim zou kunnen vallen.
  for (const vooraf of [0, 100, 182, 190, 199, 250]) {
    const w = metAuthFout(basis, (body) => {
      const plek = body.indexOf(SMTP);
      return `${"x".repeat(vooraf)}${body.slice(plek, plek + SMTP.length)} is geen geldige waarde, ${TURNSTILE} ook niet`;
    });
    const d = opzet(w, PORTAAL);
    const fout = await richtIn(ARG, d).then(
      () => null,
      (f) => f,
    );
    assert.ok(fout, "de run stopt");
    assert.match(fout.message, /config\/auth gaf 400: Bad Request; het antwoord was geen JSON/);
    const regel = uitvoerRegel({ status: "mislukt", reden: fout.message }, d.geheimen);
    for (const geheim of [SMTP, TURNSTILE]) {
      for (let lengte = 6; lengte <= geheim.length; lengte += 1) {
        assert.ok(!regel.includes(geheim.slice(0, lengte)), `geen begin van ${lengte} tekens`);
        assert.ok(!fout.message.includes(geheim.slice(0, lengte)));
      }
    }
  }
});

test("geheimen: een antwoord dat geen JSON is komt nooit in een melding, alleen zijn lengte", async () => {
  const fetchFn = async () => ({
    ok: false,
    status: 502,
    statusText: "Bad Gateway",
    text: async () => "<html>geheim-in-een-foutpagina</html>",
  });
  await assert.rejects(
    () => vraag(fetchFn, "https://api.supabase.com/v1/x?reveal=true", { token: "t" }),
    (fout) =>
      fout.status === 502 &&
      /GET \/v1\/x gaf 502: Bad Gateway; het antwoord was geen JSON \(37 tekens, niet getoond\)/.test(
        fout.message,
      ) &&
      !fout.message.includes("geheim-in"),
  );
});

test("geheimen: kaatst Supabase het SMTP-wachtwoord of het Turnstile-geheim terug in een gewone (JSON) foutmelding, dan maskeert de uitvoerregel ze", async () => {
  const basis = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(basis, DEUR));
  // De tweede run van de overgang: daarin gaat ook het Turnstile-geheim naar Supabase.
  await richtIn(ARG, opzet(basis, PORTAAL));
  // De echte API geeft een geheim nooit leesbaar terug; de run stuurt het dus opnieuw.
  auth(basis).smtp_pass = "<verborgen>";
  const w = metAuthFout(basis, (body) => JSON.stringify({ message: `ongeldig: ${body}` }));
  const d = opzet(w, PORTAAL);
  const fout = await richtIn(ARG, d).then(
    () => null,
    (f) => f,
  );
  assert.ok(fout);
  // In de fout zelf staan ze heel (de bibliotheek kent de geheimen niet), in de uitvoerregel niet.
  assert.ok(fout.message.includes(SMTP) && fout.message.includes(TURNSTILE));
  const regel = uitvoerRegel({ status: "mislukt", reden: fout.message }, d.geheimen);
  assert.ok(!regel.includes(SMTP));
  assert.ok(!regel.includes(TURNSTILE));
});

test("geheimen: geen geheim in het resultaat van een droogloop, een gewone run of Toegang bijwerken, en geen geheim naar GitHub of Cloudflare", async () => {
  const w = nepWolk({ workerBestaat: true });
  const uit = [];
  uit.push(await richtIn({ ...ARG, droogloop: true }, opzet(w, PORTAAL)));
  uit.push(await richtIn(ARG, opzet(w, PORTAAL)));
  uit.push(await richtIn(ARG, opzet(w, PORTAAL)));
  uit.push(await richtIn({ ...ARG, droogloop: true }, opzet(w, PORTAAL)));
  uit.push(await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, PORTAAL)));
  uit.push(await werkToegangBij({ voorvoegsel: "wi-", droogloop: true }, opzet(w, PORTAAL)));
  const gh = w.aanroepen.filter((a) => a.soort === "gh").map((a) => [a.args, a.invoer]);
  // Alles behalve de PATCH van de auth-config: ook de SQL van de hooks en de sessieduur.
  const rest = w.aanroepen.filter(
    (a) => a.soort === "fetch" && !(a.methode === "PATCH" && /config\/auth$/.test(a.pad)),
  );
  const tekst = JSON.stringify([uit, gh, rest.map((a) => [a.url, a.body])]);
  assert.ok(!tekst.includes(SMTP));
  assert.ok(!tekst.includes(TURNSTILE));
  const serviceRol = w.aanroepen.find((a) => a.soort === "admin")?.sleutel;
  assert.ok(serviceRol);
  assert.ok(!JSON.stringify(uit).includes(serviceRol));
  // De geheimen gaan alleen mee in de ene aanroep die ze nodig heeft.
  const met = w.aanroepen.filter((a) => JSON.stringify(a.body ?? "").includes(TURNSTILE));
  assert.ok(met.length > 0);
  for (const a of met) assert.deepEqual([a.methode, /config\/auth$/.test(a.pad)], ["PATCH", true]);
});
