/**
 * Klantportaal met accounts vooraf (uitgave 47): `"klantportaal_inloggen": "vooraf"` in
 * toegang.json. Een account komt er alleen op uitnodiging (zoals bij `account`), maar een klant
 * logt in met een link of een code per mail, en naar keuze met een wachtwoord of Google (met een
 * `google_client_id` en het secret GOOGLE_GEHEIM). Alleen voor apps van de openbare template,
 * versie 47 of later. De tests leggen vast wat de inrichting dan anders zet dan bij `account`,
 * dat het geheim van Google nergens leesbaar staat, en dat een app die niet vooraf is niets merkt.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  APP_ACCOUNTS,
  APP_VOORAF,
  KLANTACCOUNTS_INLOGDIENST,
  KLANTPORTAAL_INLOGDIENST,
  leesArgumenten,
  metConfig,
  richtIn,
  stackVersie,
  uitvoerRegel,
  VOORAF_GOOGLE_INLOGDIENST,
  VOORAF_INLOGDIENST,
} from "./inrichten-cloudflare.mjs";
import {
  auth,
  DEUR,
  HOOKS,
  opzet,
  PORTAAL,
  PORTAAL_APP,
  project,
  stap,
} from "./klantportaal-opzet.mjs";
import {
  GEHEIME_VELDEN,
  GESLOTEN_PORTAAL,
  klantportaalInstellingen,
  LINK_GELDIG_SECONDEN,
  VOORAF_LINK,
  WACHTWOORD_MINIMAAL,
} from "./lib/supabase.mjs";
import {
  googleClientIdVanApp,
  inloggenVanApp,
  MELDING_ALLEEN_UITNODIGING,
  MELDING_GEEN_WACHTWOORD,
  MELDING_MEDEWERKER,
  metKlantaccounts,
  portaalAanmeldHookSql,
  UITNODIGING_FUNCTIE,
  valideerToegang,
} from "./lib/toegang.mjs";
import { GEWOON, OPENBAAR } from "./lib/variant.mjs";
import { nepWolk } from "./nep-wolk.mjs";

const HIER = dirname(fileURLToPath(import.meta.url));
const DATA = join(HIER, "testdata", "openbaar");
const MAP = mkdtempSync(join(tmpdir(), "beheer-vooraf-"));
const ROUTE =
  '"preview_urls": true,\n  "routes": [{ "pattern": "direct.voorbeeldapps.nl", "custom_domain": true }]\n';
const MET_DOMEIN = join(MAP, "met-domein.jsonc");
writeFileSync(
  MET_DOMEIN,
  readFileSync(join(DATA, "wrangler.jsonc"), "utf8").replace('"preview_urls": true\n', ROUTE),
);
const GEWOON_MET_DOMEIN = join(MAP, "gewoon-met-domein.jsonc");
writeFileSync(
  GEWOON_MET_DOMEIN,
  readFileSync(join(HIER, "..", "wrangler.jsonc"), "utf8").replace('"preview_urls": true\n', ROUTE),
);

const CLIENT_ID = "123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com";
const GOOGLE = "GOCSPX-GeheimVanGoogle789";

const VOORAF = {
  ...PORTAAL,
  apps: { direct: { ...PORTAAL_APP, klantportaal_inloggen: "vooraf" } },
};
const MET_GOOGLE = {
  ...PORTAAL,
  apps: {
    direct: { ...PORTAAL_APP, klantportaal_inloggen: "vooraf", google_client_id: CLIENT_ID },
  },
};
const APP_47 = {
  "src/lib/env.ts": readFileSync(join(DATA, "env.ts.txt"), "utf8"),
  "stack.config.json": readFileSync(join(DATA, "stack.config.json"), "utf8"),
  [APP_ACCOUNTS.bestand]: "// de Edge Function van de app\n",
  [APP_VOORAF.bestand]: "47\n",
};

function argumenten(variant = OPENBAAR, extra = []) {
  return metConfig(
    leesArgumenten([
      "--voorvoegsel",
      "vb-",
      "--app",
      "direct",
      "--repo",
      "voorbeeld-org/direct",
      "--wrangler",
      variant === GEWOON ? GEWOON_MET_DOMEIN : MET_DOMEIN,
      "--variant",
      variant,
      "--testdatabase",
      ...extra,
    ]),
    "inrichten",
  );
}

const inst = (extra = {}) =>
  klantportaalInstellingen({
    afzender: { adres: "noreply@voorbeeldapps.nl", naam: "Voorbeeld Direct" },
    smtpWachtwoord: "x",
    captchaGeheim: "y",
    hooks: HOOKS,
    inloggen: "vooraf",
    ...extra,
  });

// ---------------------------------------------------------------- toegang.json

test("toegang.json: vooraf is een stand, google_client_id alleen bij vooraf en alleen een echte client-id, en nooit zonder captcha", () => {
  assert.equal(inloggenVanApp(valideerToegang(VOORAF), "direct"), "vooraf");
  assert.equal(metKlantaccounts(VOORAF, "direct"), true);
  assert.equal(metKlantaccounts(PORTAAL, "direct"), false);
  assert.equal(googleClientIdVanApp(valideerToegang(MET_GOOGLE), "direct"), CLIENT_ID);
  assert.equal(googleClientIdVanApp(VOORAF, "direct"), null);
  const met = (velden) => ({ ...PORTAAL, apps: { direct: { ...PORTAAL_APP, ...velden } } });
  assert.throws(
    () => valideerToegang(met({ klantportaal_inloggen: "vooraf", captcha: false })),
    /niet zonder captcha/,
  );
  // Alleen bij vooraf.
  for (const stand of [undefined, "code", "account"]) {
    assert.throws(
      () => valideerToegang(met({ klantportaal_inloggen: stand, google_client_id: CLIENT_ID })),
      /google_client_id hoort alleen bij "klantportaal_inloggen": "vooraf"/,
    );
  }
  assert.throws(
    () =>
      valideerToegang({
        ...PORTAAL,
        apps: { direct: { groepen: ["kantoor"], google_client_id: CLIENT_ID } },
      }),
    /hoort bij een klantportaal/,
  );
  // Geen client-id, of het geheim op de verkeerde plek.
  assert.throws(
    () => valideerToegang(met({ klantportaal_inloggen: "vooraf", google_client_id: "123" })),
    /eindigt op \.apps\.googleusercontent\.com/,
  );
  assert.throws(
    () => valideerToegang(met({ klantportaal_inloggen: "vooraf", google_client_id: GOOGLE })),
    /GEHEIM van de inlogkoppeling bij Google/,
  );
  assert.throws(() => valideerToegang(met({ klantportaal_inloggen: "wachtwoord" })), /"vooraf"/);
});

// ---------------------------------------------------------------- de hooks

test("aanmeld-hook bij vooraf: zoals bij account, alleen met een open uitnodiging en nooit op een adres van een medewerker; Cloudflare eerst", () => {
  const sql = portaalAanmeldHookSql(VOORAF, "direct", HOOKS.aanmelden);
  assert.ok(sql.includes(`if not coalesce(${UITNODIGING_FUNCTIE}(event), false) then`));
  assert.ok(sql.includes(MELDING_ALLEEN_UITNODIGING));
  assert.ok(sql.indexOf(MELDING_MEDEWERKER) < sql.indexOf(UITNODIGING_FUNCTIE));
  assert.ok(sql.indexOf("custom:cloudflare") < sql.indexOf(UITNODIGING_FUNCTIE));
  // Een nieuw account via Google komt niet door: alleen de aanbieder email mag een account maken.
  assert.ok(sql.includes("if aanbieder <> 'email'"));
  // Geen adres of domein uit de groepen komt erdoor.
  assert.ok(sql.includes("'voorbeeld.nl'"));
  // Met of zonder Google dezelfde hook.
  assert.equal(portaalAanmeldHookSql(MET_GOOGLE, "direct", HOOKS.aanmelden), sql);
});

// ---------------------------------------------------------------- de instellingen van Supabase

test("instellingen bij vooraf: vier keer dezelfde inlogmail met code en link naar /login met het juiste type, 24 uur geldig", () => {
  const i = inst();
  assert.equal(i.mailer_otp_exp, LINK_GELDIG_SECONDEN);
  assert.equal(LINK_GELDIG_SECONDEN, 24 * 60 * 60);
  assert.equal(i.mailer_otp_length, 10);
  assert.equal(i.password_min_length, WACHTWOORD_MINIMAAL);
  assert.equal(i.mfa_totp_enroll_enabled, true);
  assert.equal(i.mfa_totp_verify_enabled, true);
  for (const [mail, soort] of [
    ["magic_link", "email"],
    ["confirmation", "email"],
    ["invite", "invite"],
    ["recovery", "recovery"],
  ]) {
    const inhoud = i[`mailer_templates_${mail}_content`];
    assert.equal(i[`mailer_subjects_${mail}`], "Inloggen bij Voorbeeld Direct", mail);
    assert.match(inhoud, /<h2>Inloggen bij Voorbeeld Direct<\/h2>/, mail);
    assert.ok(inhoud.includes('<span id="code">{{ .Token }}</span>'), mail);
    assert.ok(
      inhoud.includes(
        `<a id="link" href="{{ .SiteURL }}/login?token_hash={{ .TokenHash }}&type=${soort}">`,
      ),
      mail,
    );
    assert.equal(
      VOORAF_LINK(soort),
      `{{ .SiteURL }}/login?token_hash={{ .TokenHash }}&type=${soort}`,
    );
    assert.match(inhoud, /Heb je dit niet zelf aangevraagd/, mail);
    assert.match(inhoud, /geef de code aan niemand/, mail);
    assert.match(inhoud, /24 uur/, mail);
    assert.doesNotMatch(inhoud, /wachtwoord-instellen|ConfirmationURL|RedirectTo/, mail);
  }
  // De rest van het klantportaal blijft: captcha, geen autoconfirm, hooks, geen eigen koppelen.
  assert.equal(i.security_captcha_enabled, true);
  assert.equal(i.mailer_autoconfirm, false);
  assert.equal(i.security_manual_linking_enabled, false);
  assert.equal(i.hook_before_user_created_enabled, true);
  // Adres wijzigen en de controlecode blijven zonder link en zonder code.
  assert.doesNotMatch(i.mailer_templates_email_change_content, /Token/);
  assert.throws(() => inst({ captcha: false }), /niet zonder captcha/);
});

test("instellingen bij vooraf: Google aan met client-id en geheim, anders uitdrukkelijk uit; het geheim is een geheim veld", () => {
  const zonder = inst();
  assert.equal(zonder.external_google_enabled, false);
  assert.equal(zonder.external_google_client_id, undefined);
  assert.equal(zonder.external_google_secret, undefined);
  const met = inst({ googleClientId: CLIENT_ID, googleGeheim: GOOGLE });
  assert.equal(met.external_google_enabled, true);
  assert.equal(met.external_google_client_id, CLIENT_ID);
  assert.equal(met.external_google_secret, GOOGLE);
  assert.ok(GEHEIME_VELDEN.includes("external_google_secret"));
  assert.throws(() => inst({ googleClientId: CLIENT_ID }), /GOOGLE_GEHEIM ontbreekt/);
  // Google alleen bij vooraf; bij code en account (en een gesloten portaal) uit.
  assert.throws(
    () => inst({ inloggen: "account", googleClientId: CLIENT_ID, googleGeheim: GOOGLE }),
    /alleen bij "klantportaal_inloggen": "vooraf"/,
  );
  assert.equal(inst({ inloggen: "code" }).external_google_enabled, false);
  assert.equal(inst({ inloggen: "account" }).external_google_enabled, false);
  assert.equal(GESLOTEN_PORTAAL.external_google_enabled, false);
  // Bij de code per mail blijft de mail van 15 minuten met de link zonder type-keuze.
  assert.equal(inst({ inloggen: "code" }).mailer_otp_exp, 900);
});

// ---------------------------------------------------------------- de inrichting

test("inrichten bij vooraf zonder Google: VITE_INLOGDIENST cloudflare,mailcode,wachtwoord, de hooks met uitnodiging, Google uit, en de stand in de samenvatting", async () => {
  const w = nepWolk({ ghBestanden: APP_47 });
  // Eerst een gewone app met een deur; daarna wordt hij een klantportaal (de deur blijft staan).
  await richtIn(argumenten(), opzet(w, DEUR));
  const r = await richtIn(argumenten(), opzet(w, VOORAF));
  assert.equal(VOORAF_INLOGDIENST, "cloudflare,mailcode,wachtwoord");
  assert.equal(w.staat.ghVariabelen.production.VITE_INLOGDIENST, VOORAF_INLOGDIENST);
  assert.equal(w.staat.ghVariabelen.preview.VITE_INLOGDIENST, "cloudflare");
  assert.match(stap(r, "3.4 hooks van het klantportaal"), /alleen op uitnodiging/);
  assert.match(stap(r, "3.4 accounts vooraf"), /Google uit/);
  const a = auth(w);
  assert.equal(a.external_google_enabled, false);
  assert.equal(a.mailer_otp_exp, 86400);
  assert.match(a.mailer_templates_invite_content, /type=invite/);
  const sql = w.staat.sql.join("\n");
  assert.ok(sql.includes(UITNODIGING_FUNCTIE));
  assert.ok(!sql.includes(MELDING_GEEN_WACHTWOORD), "de token-hook weigert geen wachtwoord");
  assert.ok(
    r.waarschuwingen.some(
      (x) =>
        /accounts vooraf/.test(x) && /rate-limitregel/.test(x) && !/wachtwoord-vergeten/.test(x),
    ),
  );
  assert.ok(r.waarschuwingen.some((x) => /klant-uitnodigen/.test(x)));
  assert.ok(r.watNu.some((x) => /inloglink/.test(x)));
});

test("inrichten bij vooraf met Google: Google aan, het geheim alleen in de PATCH en gemaskeerd, de run met het vinkje vergelijkt de velden van Google behalve het geheim", async () => {
  const w = nepWolk({ ghBestanden: APP_47 });
  await richtIn(argumenten(), opzet(w, DEUR));
  assert.ok(
    w.staat.apps.some((x) => x.name === "vb-direct"),
    "de deur staat er",
  );
  const d = opzet(w, MET_GOOGLE, { googleGeheim: GOOGLE });
  const r = await richtIn(argumenten(), d);
  assert.equal(VOORAF_GOOGLE_INLOGDIENST, "cloudflare,mailcode,google,wachtwoord");
  assert.equal(w.staat.ghVariabelen.production.VITE_INLOGDIENST, VOORAF_GOOGLE_INLOGDIENST);
  const a = auth(w);
  assert.equal(a.external_google_enabled, true);
  assert.equal(a.external_google_client_id, CLIENT_ID);
  assert.equal(a.external_google_secret, GOOGLE);
  assert.ok(d.geheimen.includes(GOOGLE), "het geheim van Google is gemaskeerd");
  assert.match(stap(r, "3.4 accounts vooraf"), new RegExp(`Google aan \\(client-id ${CLIENT_ID}`));
  assert.ok(!JSON.stringify(r).includes(GOOGLE), "het geheim staat niet in het resultaat");
  assert.ok(!uitvoerRegel(r, d.geheimen).includes(GOOGLE));

  // Een ander geheim in Supabase telt niet als iets te wijzigen (geheimen vergelijkt het vinkje niet).
  const ref = project(w).ref;
  w.staat.auth[ref].external_google_secret = "GOCSPX-IetsAnders";
  // Een andere client-id wel: dan gaat de deur niet weg.
  w.staat.auth[ref].external_google_client_id = "999-ander.apps.googleusercontent.com";
  await assert.rejects(
    richtIn(
      { ...argumenten(), deurWeghalen: true },
      opzet(w, MET_GOOGLE, { googleGeheim: GOOGLE }),
    ),
    /external_google_client_id/,
  );
  assert.ok(
    w.staat.apps.some((x) => x.name === "vb-direct"),
    "de deur staat er nog",
  );
  w.staat.auth[ref].external_google_client_id = CLIENT_ID;
  await richtIn(
    { ...argumenten(), deurWeghalen: true },
    opzet(w, MET_GOOGLE, { googleGeheim: GOOGLE }),
  );
  assert.equal(
    w.staat.apps.some((x) => x.name === "vb-direct"),
    false,
  );
});

test("inrichten bij vooraf stopt vóór de eerste wijziging zonder GOOGLE_GEHEIM, bij een app ouder dan 47, zonder klant-uitnodigen of van de gewone template", async () => {
  const geen = (w) => assert.deepEqual(w.staat.projecten, []);
  const w1 = nepWolk({ ghBestanden: APP_47 });
  await assert.rejects(richtIn(argumenten(), opzet(w1, MET_GOOGLE)), /GOOGLE_GEHEIM ontbreekt/);
  geen(w1);
  const w2 = nepWolk({ ghBestanden: { ...APP_47, [APP_VOORAF.bestand]: "46\n" } });
  await assert.rejects(richtIn(argumenten(), opzet(w2, VOORAF)), /versie 47 of later/);
  geen(w2);
  const zonderVersie = { ...APP_47 };
  delete zonderVersie[APP_VOORAF.bestand];
  const w3 = nepWolk({ ghBestanden: zonderVersie });
  await assert.rejects(richtIn(argumenten(), opzet(w3, VOORAF)), /versie 47 of later/);
  geen(w3);
  const zonderFunctie = { ...APP_47 };
  delete zonderFunctie[APP_ACCOUNTS.bestand];
  const w4 = nepWolk({ ghBestanden: zonderFunctie });
  await assert.rejects(richtIn(argumenten(), opzet(w4, VOORAF)), /klant-uitnodigen/);
  geen(w4);
  const w5 = nepWolk({ ghBestanden: APP_47 });
  await assert.rejects(
    richtIn(argumenten(GEWOON), opzet(w5, VOORAF)),
    /alleen in de openbare template/,
  );
  geen(w5);
  assert.equal(stackVersie("47\n"), 47);
  assert.equal(stackVersie("geen getal"), null);
});

test("droogloop bij vooraf noemt de stand en Google, en waarschuwt voor het ontbrekende geheim zonder iets te wijzigen", async () => {
  const w = nepWolk({ ghBestanden: APP_47 });
  const r = await richtIn({ ...argumenten(), droogloop: true }, opzet(w, MET_GOOGLE));
  const plan = stap(r, "3.4 auth-config");
  assert.match(plan, /klantportaal met accounts vooraf/);
  assert.match(plan, new RegExp(`Google aan \\(client-id ${CLIENT_ID}\\)`));
  assert.ok(r.waarschuwingen.some((x) => /de echte run stopt hierop.*GOOGLE_GEHEIM/.test(x)));
  assert.deepEqual(w.staat.projecten, []);
});

test("een app die niet vooraf is, merkt niets: code en account houden hun VITE_INLOGDIENST, lezen geen stack-version en zetten Google niet aan", async () => {
  const zonderVersie = { ...APP_47 };
  delete zonderVersie[APP_VOORAF.bestand];
  const w = nepWolk({ ghBestanden: zonderVersie });
  await richtIn(argumenten(), opzet(w, PORTAAL, { googleGeheim: GOOGLE }));
  assert.equal(w.staat.ghVariabelen.production.VITE_INLOGDIENST, KLANTPORTAAL_INLOGDIENST);
  assert.notEqual(auth(w).external_google_enabled, true);
  assert.ok(!w.aanroepen.some((x) => JSON.stringify(x).includes(APP_VOORAF.bestand)));
  const ACCOUNTS = {
    ...PORTAAL,
    apps: { direct: { ...PORTAAL_APP, klantportaal_inloggen: "account" } },
  };
  const w2 = nepWolk({ ghBestanden: zonderVersie });
  await richtIn(argumenten(), opzet(w2, ACCOUNTS, { googleGeheim: GOOGLE }));
  assert.equal(w2.staat.ghVariabelen.production.VITE_INLOGDIENST, KLANTACCOUNTS_INLOGDIENST);
  assert.notEqual(auth(w2).external_google_enabled, true);
  assert.ok(!JSON.stringify(auth(w2)).includes(GOOGLE), "het geheim van Google komt nergens");
});
