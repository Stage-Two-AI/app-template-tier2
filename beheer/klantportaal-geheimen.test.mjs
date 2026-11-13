/**
 * Klantportaal, de geheimen: het SMTP-wachtwoord, het Turnstile-geheim en de service-sleutel
 * komen nooit in de uitvoer, het resultaat van een droogloop of een foutmelding, ook niet een
 * stuk ervan.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  eindstatus,
  richtIn,
  samenvatting,
  schrijfSamenvatting,
  uitvoerRegel,
  werkToegangBij,
} from "./inrichten-cloudflare.mjs";
import {
  ARG,
  auth,
  DEUR,
  GROEPEN,
  MET_VINKJE,
  opzet,
  PORTAAL,
  PORTAAL_APP,
  SITEKEY,
  SMTP,
  TURNSTILE,
} from "./klantportaal-opzet.mjs";
import { SITEKEY_MAX, valideerToegang } from "./lib/toegang.mjs";
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
    assert.match(fout.message, /config\/auth gaf 400\. De melding van Supabase is niet getoond/);
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

test("geheimen: kaatst Supabase een geheim (of een afgekapt stuk ervan) terug in een gewone JSON-foutmelding, dan komt die melding niet in de fout: alleen de status en de genoemde velden", async () => {
  const basis = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(basis, DEUR));
  const stuk = SMTP.slice(0, 14);
  for (const melding of [
    (body) => `ongeldig: ${body}`,
    () => `smtp_pass: ongeldige waarde "${stuk}..."`,
    () => `security_captcha_secret begint met ${TURNSTILE.slice(0, 9)}`,
  ]) {
    const w = metAuthFout(basis, (body) => JSON.stringify({ message: melding(body) }));
    const d = opzet(w, PORTAAL);
    const fout = await richtIn(ARG, d).then(
      () => null,
      (f) => f,
    );
    assert.ok(fout);
    assert.match(
      fout.message,
      /PATCH \/v1\/projects\/[a-z0-9]+\/config\/auth gaf 400\. De melding van Supabase is niet getoond/,
    );
    assert.equal(fout.status, 400);
    // Niet het geheim, en ook geen begin ervan dat geen maskering nog herkent.
    const regel = uitvoerRegel({ status: "mislukt", reden: fout.message }, []);
    for (const geheim of [SMTP, TURNSTILE]) {
      for (let lengte = 6; lengte <= geheim.length; lengte += 1) {
        assert.ok(!regel.includes(geheim.slice(0, lengte)), `geen begin van ${lengte} tekens`);
      }
    }
  }
  // Welke velden Supabase noemt, staat er wel: daar kan de owner mee verder.
  const w = metAuthFout(basis, () => JSON.stringify({ message: "smtp_pass is te kort" }));
  await assert.rejects(() => richtIn(ARG, opzet(w, PORTAAL)), /ze noemt: smtp_pass/);
  // Een wijziging zonder geheim (een gewone app) houdt de melding van Supabase, zoals altijd.
  const gewoon = nepWolk({
    faal: (methode, pad) =>
      methode === "PATCH" && pad.endsWith("/config/auth") ? { status: 500, message: "stuk" } : null,
  });
  await assert.rejects(() => richtIn(ARG, opzet(gewoon, DEUR)), /config\/auth gaf 500: stuk/);
});

test("geheimen: geen geheim in het resultaat van een droogloop, een gewone run of Toegang bijwerken, en geen geheim naar GitHub of Cloudflare", async () => {
  const w = nepWolk({ workerBestaat: true });
  const uit = [];
  uit.push(await richtIn({ ...ARG, droogloop: true }, opzet(w, PORTAAL)));
  uit.push(await richtIn(ARG, opzet(w, PORTAAL)));
  uit.push(await richtIn({ ...ARG, deurWeghalen: true }, opzet(w, PORTAAL)));
  uit.push(await richtIn({ ...ARG, droogloop: true }, opzet(w, PORTAAL)));
  uit.push(await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, PORTAAL)));
  uit.push(await werkToegangBij({ voorvoegsel: "wi-", droogloop: true }, opzet(w, PORTAAL)));
  const gh = w.aanroepen.filter((a) => a.soort === "gh").map((a) => [a.args, a.invoer]);
  // Alles behalve de PATCH van de auth-config en de toets bij Turnstile: ook de SQL van de
  // hooks en de sessieduur.
  const naarTurnstile = (a) =>
    a.url === "https://challenges.cloudflare.com/turnstile/v0/siteverify";
  const rest = w.aanroepen.filter(
    (a) =>
      a.soort === "fetch" &&
      !(a.methode === "PATCH" && /config\/auth$/.test(a.pad)) &&
      !naarTurnstile(a),
  );
  const tekst = JSON.stringify([uit, gh, rest.map((a) => [a.url, a.body])]);
  assert.ok(!tekst.includes(SMTP));
  assert.ok(!tekst.includes(TURNSTILE));
  const serviceRol = w.aanroepen.find((a) => a.soort === "admin")?.sleutel;
  assert.ok(serviceRol);
  assert.ok(!JSON.stringify(uit).includes(serviceRol));
  // Ook zonder enige maskering van de uitvoerregel: geen service-sleutel, geen client-secret.
  const kaal = uit.map((r) => uitvoerRegel(r, [])).join("\n");
  for (const geheim of [SMTP, TURNSTILE, "geheim-sr-", "geheim-cs-"]) {
    assert.ok(!kaal.includes(geheim), geheim);
  }
  // De geheimen gaan alleen mee in de aanroepen die ze nodig hebben: het Turnstile-geheim
  // naar Supabase en naar de toets bij Turnstile zelf, het SMTP-wachtwoord alleen naar Supabase.
  const met = (geheim) => w.aanroepen.filter((a) => JSON.stringify(a.body ?? "").includes(geheim));
  assert.ok(met(TURNSTILE).some(naarTurnstile));
  for (const a of met(TURNSTILE)) {
    assert.ok(naarTurnstile(a) || (a.methode === "PATCH" && /config\/auth$/.test(a.pad)), a.url);
  }
  assert.ok(met(SMTP).length > 0);
  for (const a of met(SMTP))
    assert.deepEqual([a.methode, /config\/auth$/.test(a.pad)], ["PATCH", true]);
});

// ---------------------------------------------------------------- de twee sleutels van Turnstile

test("Turnstile: de geheime sleutel in turnstile_sitekey wordt geweigerd (dezelfde waarde als het secret, of de lengte van een geheim) en komt nooit in een variabele van de app", async () => {
  // Dezelfde waarde als het secret TURNSTILE_GEHEIM: de inrichting stopt vóór de eerste wijziging.
  const fout = {
    groepen: GROEPEN,
    apps: { direct: { ...PORTAAL_APP, turnstile_sitekey: TURNSTILE } },
  };
  const w = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(w, DEUR));
  w.aanroepen.length = 0;
  const d = opzet(w, fout);
  const weigering = await richtIn(ARG, d).catch((f) => f);
  assert.match(
    weigering.message,
    /gestopt zonder wijzigingen.*turnstile_sitekey in toegang\.json en het secret TURNSTILE_GEHEIM zijn dezelfde waarde.*Rotate secret/,
  );
  assert.deepEqual(w.schrijfacties(), []);
  assert.equal(w.staat.ghVariabelen.production.VITE_TURNSTILE_SITEKEY, undefined);
  assert.ok(
    !uitvoerRegel({ status: "mislukt", reden: weigering.message }, d.geheimen).includes(TURNSTILE),
  );
  // Ook de droogloop zegt het, zonder het geheim te tonen.
  const droog = await richtIn({ ...ARG, droogloop: true }, opzet(w, fout));
  assert.match(droog.waarschuwingen.join(" "), /de echte run stopt hierop.*dezelfde waarde/);
  // Een waarde met de lengte van een geheim (rond de 35 tekens) weigert toegang.json zelf al,
  // ook als het secret er (nog) niet is.
  const lang = "0x4AAAAAAADnPIDROrmt1Wwj-GeheimDeel1";
  assert.ok(lang.length > SITEKEY_MAX && SITEKEY.length <= SITEKEY_MAX);
  assert.throws(
    () =>
      valideerToegang({
        groepen: GROEPEN,
        apps: { direct: { ...PORTAAL_APP, turnstile_sitekey: lang } },
      }),
    /heeft de lengte van de GEHEIME sleutel van Turnstile/,
  );
  valideerToegang(structuredClone(PORTAAL));
});

test("Turnstile: het geheim wordt getoetst vóór de captcha aangaat; een verkeerd geheim (ook de openbare sleutel in het secret) stopt de run vóór de eerste wijziging", async () => {
  // De widget kent alleen het echte geheim.
  const w = nepWolk({ workerBestaat: true, turnstileGeheimen: [TURNSTILE] });
  await richtIn(ARG, opzet(w, DEUR));
  // De owner plakte de openbare sleutel in het secret (de twee lijken op elkaar), of een
  // geheim van een andere widget.
  for (const captchaGeheim of [SITEKEY, "0x4GeheimVanEenAndereWidget"]) {
    for (const arg of [ARG, { ...ARG, deurWeghalen: true }]) {
      w.aanroepen.length = 0;
      const fout = await richtIn(arg, opzet(w, PORTAAL, { captchaGeheim })).catch((f) => f);
      assert.match(
        fout.message,
        /gestopt zonder wijzigingen.*(dezelfde waarde|Turnstile kent dit geheim niet)/,
      );
      assert.deepEqual(w.schrijfacties(), []);
      assert.notEqual(auth(w).security_captcha_enabled, true);
      assert.equal(auth(w).external_email_enabled, false);
    }
  }
  const droog = await richtIn(
    { ...ARG, droogloop: true },
    opzet(w, PORTAAL, { captchaGeheim: "0x4GeheimVanEenAndereWidget" }),
  );
  assert.match(
    droog.waarschuwingen.join(" "),
    /de echte run stopt hierop.*Turnstile kent dit geheim niet/,
  );
  // Het goede geheim: één toets, vóór de eerste schrijfactie, met een verzonnen bewijs.
  w.aanroepen.length = 0;
  await richtIn(ARG, opzet(w, PORTAAL));
  const toets = w.aanroepen.filter(
    (a) => a.url === "https://challenges.cloudflare.com/turnstile/v0/siteverify",
  );
  assert.equal(toets.length, 1);
  assert.deepEqual(toets[0].body, { secret: TURNSTILE, response: "toets-van-de-inrichting" });
  const eersteWijziging = w.aanroepen.findIndex(
    (a) =>
      (a.soort === "fetch" && !["GET"].includes(a.methode) && a !== toets[0]) ||
      (a.soort === "gh" && a.args[1] === "set"),
  );
  assert.ok(w.aanroepen.indexOf(toets[0]) < eersteWijziging);
  assert.equal(auth(w).security_captcha_enabled, true);
  // Is Turnstile niet te bereiken, dan is er niets getoetst en gebeurt er ook niets.
  const d = opzet(w, PORTAAL);
  const basis = d.fetchFn;
  d.fetchFn = async (url, o) => {
    if (String(url).includes("siteverify")) throw new Error("netwerk");
    return basis(url, o);
  };
  await assert.rejects(
    () => richtIn(ARG, d),
    /Turnstile was niet te bereiken, dus het geheim is niet getoetst/,
  );
  // Met "captcha": false wordt er niets getoetst en is het geheim niet nodig.
  const zonder = { groepen: GROEPEN, apps: { direct: { ...PORTAAL_APP, captcha: false } } };
  w.aanroepen.length = 0;
  await richtIn(ARG, opzet(w, zonder, { captchaGeheim: undefined }));
  assert.equal(w.aanroepen.filter((a) => String(a.url).includes("siteverify")).length, 0);
  // En een gewone app raakt Turnstile nooit.
  const gewoon = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(gewoon, DEUR));
  assert.equal(gewoon.aanroepen.filter((a) => String(a.url).includes("siteverify")).length, 0);
});

test("Turnstile: de openbare testsleutels (een cijfer, een x en nullen) worden geweigerd, als geheim en als sitekey: daarmee slaagt elke captcha", async () => {
  // De testgeheimen kent Turnstile wel; de toets bij siteverify zou ze dus goedkeuren.
  for (const geheim of [
    "1x0000000000000000000000000000000AA",
    "2x0000000000000000000000000000000AA",
    "3x0000000000000000000000000000000AA",
  ]) {
    const w = nepWolk({ workerBestaat: true });
    await richtIn(ARG, opzet(w, DEUR));
    w.aanroepen.length = 0;
    await assert.rejects(
      () => richtIn(ARG, opzet(w, PORTAAL, { captchaGeheim: geheim })),
      /gestopt zonder wijzigingen.*TURNSTILE_GEHEIM is een openbaar testgeheim van Turnstile/,
    );
    assert.deepEqual(w.schrijfacties(), []);
    assert.ok(
      !w.aanroepen.some((a) => a.pad?.includes("siteverify")),
      "het testgeheim gaat niet eens naar Turnstile",
    );
  }
  for (const sitekey of [
    "1x00000000000000000000AA",
    "2x00000000000000000000AB",
    "1x00000000000000000000BB",
    "3x00000000000000000000FF",
  ]) {
    assert.throws(
      () =>
        valideerToegang({
          groepen: GROEPEN,
          apps: { direct: { ...PORTAAL_APP, turnstile_sitekey: sitekey } },
        }),
      /turnstile_sitekey is een openbare testsleutel van Turnstile/,
    );
  }
  // Een echte sleutel (begint bij Cloudflare met 0x4) blijft gewoon werken.
  valideerToegang(PORTAAL);
});

test("de samenvatting van de run: gewone taal, de volgende stap erbij, en geen geheim of klantadres; alleen in GitHub Actions, als bestand naast de uitvoer", async () => {
  const w = nepWolk({
    workerBestaat: true,
    gebruikers: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        email: "inkoop@bloemist.nl",
        app_metadata: { provider: "email", providers: ["email"] },
      },
    ],
  });
  await richtIn(ARG, opzet(w, DEUR));
  const d = opzet(w, PORTAAL);
  const r = await richtIn(ARG, d);
  const tekst = samenvatting("inrichten", eindstatus("inrichten", r));
  assert.match(tekst, /^## App inrichten: direct\n\nGelukt\./);
  assert.match(tekst, /\*\*Wat er is gedaan\*\*/);
  assert.match(
    tekst,
    /\*\*Wat nu\*\*\n\n1\. Rol de app uit.*\n2\. Test achter de deur.*\n3\. Werkt dat, draai App inrichten/,
  );
  // Een run die stopt: de reden, in dezelfde woorden als de uitvoer.
  const fout = await richtIn(MET_VINKJE, opzet(w, PORTAAL, { smtpWachtwoord: undefined })).catch(
    (f) => f,
  );
  const rood = samenvatting("inrichten", {
    status: "mislukt",
    modus: "inrichten",
    reden: fout.message,
  });
  assert.match(
    rood,
    /\*\*Mislukt\.\*\* gestopt zonder wijzigingen: klantportaal direct: het secret SMTP_WACHTWOORD ontbreekt/,
  );
  // Toegang bijwerken: aantallen, nooit adressen.
  const t = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, PORTAAL));
  const toegang = samenvatting("toegang", eindstatus("toegang", t));
  assert.match(toegang, /direct: 1 klantaccounts overgeslagen/);
  assert.match(toegang, /Wat nu[\s\S]*Klantportaal direct: de deur staat er nog/);
  assert.doesNotMatch(toegang, /bloemist/);
  // Het bestand: alleen als GitHub het aanwijst, en met de geheimen eruit.
  const map = mkdtempSync(join(tmpdir(), "samenvatting-"));
  try {
    const bestand = join(map, "samenvatting.md");
    assert.equal(schrijfSamenvatting(tekst, d.geheimen, {}), false);
    assert.equal(existsSync(bestand), false);
    const metGeheim = `${tekst}\nsmtp ${SMTP} captcha ${TURNSTILE}\n`;
    assert.equal(
      schrijfSamenvatting(metGeheim, [SMTP, TURNSTILE], { GITHUB_STEP_SUMMARY: bestand }),
      true,
    );
    const geschreven = readFileSync(bestand, "utf8");
    assert.match(geschreven, /## App inrichten: direct/);
    assert.doesNotMatch(geschreven, new RegExp(`${SMTP}|${TURNSTILE}`));
    // Lukt het schrijven niet, dan verandert dat niets aan de run.
    assert.equal(
      schrijfSamenvatting(tekst, [], { GITHUB_STEP_SUMMARY: join(map, "bestaat", "niet.md") }),
      false,
    );
  } finally {
    rmSync(map, { recursive: true, force: true });
  }
});
