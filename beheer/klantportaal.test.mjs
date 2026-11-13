/**
 * Klantportaal (`"klantportaal": true` in toegang.json): een app die open is voor klanten.
 * Geen deur op het eigen domein, klanten loggen in per mail, medewerkers blijven via
 * Cloudflare inloggen, en het workers.dev-adres en de previews blijven dicht. Toegang
 * bijwerken bant geen klanten, wel een vertrokken medewerker. Alles tegen de nagebootste
 * API (nep-wolk.mjs); een gewone app bewaakt regressie-42.test.mjs.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  eindstatus,
  KLANTPORTAAL_INLOGDIENST,
  richtIn,
  ruimOp,
  uitvoerRegel,
  werkToegangBij,
} from "./inrichten-cloudflare.mjs";
import { cloudflareClient } from "./lib/cloudflare.mjs";
import {
  CODE_GELDIG_SECONDEN,
  CODE_LENGTE,
  INLOGLINK,
  inlogmail,
  klantportaalInstellingen,
  MELDINGSMAILS_UIT,
  REM,
  SESSIE,
  supabaseBeheer,
} from "./lib/supabase.mjs";
import { CLOUDFLARE_IDENTITEITEN_SQL } from "./lib/toegang.mjs";
import { nepWolk } from "./nep-wolk.mjs";

const GROEPEN = { kantoor: { domeinen: ["voorbeeld.nl"], uitsluiten: ["oud@voorbeeld.nl"] } };
const AFZENDER = "Voorbeeld Direct <noreply@voorbeeldapps.nl>";
const DEUR = { groepen: GROEPEN, apps: { direct: ["kantoor"] } };
const SITEKEY = "0x4AAAAAAAOpenbareSleutel";
const PORTAAL = {
  groepen: GROEPEN,
  apps: {
    direct: {
      groepen: ["kantoor"],
      klantportaal: true,
      afzender: AFZENDER,
      turnstile_sitekey: SITEKEY,
    },
  },
};
const HOOKS = { aanmelden: "vb_portaal_voor_aanmelden", token: "vb_portaal_voor_token" };
const ARG = {
  app: "direct",
  hostname: "direct.voorbeeldapps.nl",
  worker: "vb-direct",
  repo: "voorbeeld-org/direct",
  voorvoegsel: "vb-",
  droogloop: false,
};
const SMTP = "re_GeheimeSleutelVanResend123";
const TURNSTILE = "0x4GeheimVanTurnstile456";
const NAMEN = {
  deur: "vb-direct",
  inlog: "vb-direct-inlog",
  worker: "vb-direct-worker",
  publiek: "vb-direct-publiek",
};

function opzet(w, toegang, extra = {}) {
  const geheimen = [];
  return {
    cf: cloudflareClient({
      fetchFn: w.fetchFn,
      token: "cf-token",
      accountId: "acc",
      teamDomein: "stagetwo",
    }),
    supabase: supabaseBeheer({
      fetchFn: w.fetchFn,
      token: "sb-token",
      orgSlug: "voorbeeld",
      slaap: async () => {},
    }),
    maakAdmin: w.maakAdmin,
    gh: w.gh,
    fetchFn: w.fetchFn,
    wachtOpDiscovery: async () => {},
    toegang,
    accountId: "acc",
    wachtwoord: () => "GeheimDatabaseWachtwoord1234567",
    maskeer: (waarde) => geheimen.push(waarde),
    geheimen,
    smtpWachtwoord: SMTP,
    captchaGeheim: TURNSTILE,
    ...extra,
  };
}

const app = (w, naam) => w.staat.apps.find((a) => a.name === naam);
const project = (w, naam = "vb-direct") => w.staat.projecten.find((p) => p.name === naam);
const auth = (w, naam) => w.staat.auth[project(w, naam).ref];
const stap = (r, naam) => r.stappen.find((s) => s.stap === naam)?.actie;
const cfSchrijf = (w) => w.schrijfacties().filter((s) => / cf\//.test(s));

const MET_VINKJE = { ...ARG, deurWeghalen: true };

/**
 * Van deur naar klantportaal: een run zonder vinkje zet alles klaar en laat de deur staan; de
 * owner rolt uit, test, en draait daarna met het vinkje "Deur weghalen". Geeft het resultaat
 * van die laatste run.
 */
async function naarPortaal(w, toegang = PORTAAL, arg = ARG) {
  await richtIn(arg, opzet(w, toegang));
  return richtIn({ ...arg, deurWeghalen: true }, opzet(w, toegang));
}

/** De Access op de Worker dekt workers.dev en elk preview-adres, met de groep als policy. */
function eisWorkerDicht(w) {
  const worker = app(w, NAMEN.worker);
  assert.ok(worker, "de Access op de Worker staat er");
  assert.deepEqual(
    worker.destinations.map((x) => x.uri),
    ["vb-direct.stagetwo-acc.workers.dev", "*-vb-direct.stagetwo-acc.workers.dev"],
  );
  const groep = w.staat.policies.find((p) => p.name === "vb-kantoor");
  assert.deepEqual(worker.policies, [{ id: groep.id, precedence: 1 }]);
  assert.equal(groep.decision, "allow");
  assert.ok(!w.staat.policies.some((p) => p.decision === "bypass"), "nergens een bypass");
}

// ---------------------------------------------------------------- de deur

test("deur weg: een run zonder vinkje laat de deur staan, hoe vaak ook; alleen een run met het vinkje haalt hem weg, als allerlaatste, en de rest blijft staan", async () => {
  const w = nepWolk();
  await richtIn(ARG, opzet(w, DEUR));
  const deurId = app(w, NAMEN.deur).id;
  const inlogVoor = structuredClone(app(w, NAMEN.inlog));
  assert.equal(app(w, NAMEN.deur).domain, "direct.voorbeeldapps.nl");

  // Zonder vinkje: alles staat klaar (mail, hooks, captcha, variabelen), de deur blijft. Ook
  // bij de tweede en de derde keer: een run zonder vinkje is veilig te herhalen.
  let r1;
  for (let keer = 0; keer < 3; keer += 1) {
    w.aanroepen.length = 0;
    r1 = await richtIn(ARG, opzet(w, PORTAAL));
    assert.equal(app(w, NAMEN.deur)?.id, deurId, `run ${keer + 1}: de deur staat er nog`);
    // Alleen de eerste keer: het merk van een klantportaal op de Access op de Worker.
    assert.deepEqual(
      cfSchrijf(w),
      keer === 0 ? [`PUT cf/access/apps/${app(w, NAMEN.worker).id} self_hosted`] : [],
    );
  }
  assert.equal(auth(w).external_email_enabled, true);
  assert.equal(auth(w).security_captcha_enabled, true, "de captcha staat meteen aan");
  assert.equal(w.staat.ghVariabelen.production.VITE_INLOGDIENST, "cloudflare,mailcode");
  assert.match(
    stap(r1, "3.5 Access-app op de hostname"),
    /blijft staan.*alleen een run met het vinkje/,
  );
  assert.equal(r1.cloudflare.deur, deurId);
  assert.ok(
    r1.waarschuwingen.some((x) => /deur vb-direct staat er nog.*Alles staat klaar/.test(x)),
    JSON.stringify(r1.waarschuwingen),
  );
  assert.match(r1.watNu.join(" "), /Rol de app uit.*privéadres.*met het vinkje/);

  // Met het vinkje: alles stond al klaar; nu gaat de deur weg.
  w.aanroepen.length = 0;
  const r = await richtIn(MET_VINKJE, opzet(w, PORTAAL));
  assert.equal(app(w, NAMEN.deur), undefined, "de deur op het domein is weg");
  assert.ok(
    !w.staat.apps.some(
      (a) =>
        a.domain?.startsWith("direct.voorbeeldapps.nl") ||
        (a.destinations ?? []).some((x) => x.uri.startsWith("direct.voorbeeldapps.nl")),
    ),
    "geen enkele Access-app meer op het domein",
  );
  // De inlogdienst voor medewerkers blijft, met dezelfde client en dezelfde groep.
  assert.deepEqual(app(w, NAMEN.inlog), inlogVoor);
  assert.equal(app(w, NAMEN.inlog).type, "saas");
  eisWorkerDicht(w);

  // De deur is de laatste aanroep van de run, en de enige wijziging.
  const laatste = w.aanroepen.at(-1);
  assert.equal(laatste.methode, "DELETE");
  assert.match(laatste.pad, new RegExp(`/access/apps/${deurId}$`));
  assert.deepEqual(cfSchrijf(w), [`DELETE cf/access/apps/${deurId}`]);

  assert.match(stap(r, "3.5 Access-app op de hostname"), /weggehaald.*klantportaal.*open/);
  assert.equal(r.cloudflare.deur, null);
  assert.ok(r.waarschuwingen.some((x) => /RLS.*enige grens/.test(x)));
  assert.deepEqual(w.schrijfacties(), [`DELETE cf/access/apps/${deurId}`]);

  // Een volgende run, met of zonder vinkje, verandert niets op Cloudflare en maakt geen deur.
  for (const arg of [ARG, MET_VINKJE]) {
    w.aanroepen.length = 0;
    const r3 = await richtIn(arg, opzet(w, PORTAAL));
    assert.deepEqual(cfSchrijf(w), []);
    assert.match(stap(r3, "3.5 Access-app op de hostname"), /^geen deur/);
  }
});

test("deur weg: een nieuwe app die meteen klantportaal is, krijgt nooit een deur op het domein, wel de Access op de Worker", async () => {
  const w = nepWolk();
  const r = await richtIn(ARG, opzet(w, PORTAAL));
  assert.equal(app(w, NAMEN.deur), undefined);
  assert.ok(
    !w.aanroepen.some(
      (a) =>
        a.methode === "POST" &&
        /access\/apps$/.test(a.pad ?? "") &&
        a.body?.domain === ARG.hostname,
    ),
    "er is nooit een Access-app op het domein aangemaakt",
  );
  eisWorkerDicht(w);
  assert.equal(app(w, NAMEN.inlog).type, "saas");
  // De placeholder en de Access op de Worker komen vóór de GitHub-variabelen (dus vóór de
  // eerste uitrol), net als bij een gewone app.
  const acties = w.schrijfacties();
  const access = acties.indexOf("POST cf/access/apps self_hosted");
  const eersteVariabele = acties.findIndex((s) =>
    s.startsWith("gh variable set VITE_SUPABASE_URL"),
  );
  assert.ok(access !== -1 && access < eersteVariabele, JSON.stringify(acties));
  assert.match(stap(r, "3.5 Access-app op de hostname"), /^geen deur/);
});

test("deur terug: van klantportaal terug naar een gewone app zet de inrichting de deur terug en mail uit", async () => {
  const w = nepWolk();
  await richtIn(ARG, opzet(w, PORTAAL));
  assert.equal(app(w, NAMEN.deur), undefined);
  assert.equal(auth(w).external_email_enabled, true);

  w.aanroepen.length = 0;
  const r = await richtIn(ARG, opzet(w, DEUR, { smtpWachtwoord: undefined }));

  const deur = app(w, NAMEN.deur);
  assert.ok(deur, "de deur staat er weer");
  assert.equal(deur.type, "self_hosted");
  assert.equal(deur.domain, "direct.voorbeeldapps.nl");
  assert.deepEqual(deur.destinations, [{ type: "public", uri: "direct.voorbeeldapps.nl" }]);
  const groep = w.staat.policies.find((p) => p.name === "vb-kantoor");
  assert.deepEqual(deur.policies, [{ id: groep.id, precedence: 1 }]);
  assert.deepEqual(deur.allowed_idps, ["idp-otp"]);
  assert.match(stap(r, "3.5 Access-app op de hostname"), /^aangemaakt/);
  assert.equal(r.cloudflare.deur, deur.id);
  // De deur komt eerst terug; pas daarna gaat inloggen per mail uit, in dezelfde aanroep
  // waarin autoconfirm weer aan gaat.
  assert.equal(auth(w).external_email_enabled, false);
  assert.equal(auth(w).mailer_autoconfirm, true);
  const acties = w.schrijfacties();
  assert.ok(
    acties.indexOf("POST cf/access/apps self_hosted") <
      acties.findIndex((s) => /^PATCH sb\/.*config\/auth/.test(s)),
  );
  // Een gesloten portaal blijft in een veilige stand: adres wijzigen is niet te bevestigen
  // (een mail zonder code, wat er ook stond), en loskoppelen en anoniem aanmelden staan uit.
  assert.equal(auth(w).mailer_secure_email_change_enabled, true);
  assert.equal(auth(w).security_manual_linking_enabled, false);
  assert.equal(auth(w).external_anonymous_users_enabled, false);
  assert.doesNotMatch(auth(w).mailer_templates_email_change_content, /\{\{/);
  assert.equal(w.staat.ghVariabelen.production.VITE_INLOGDIENST, "cloudflare");
  eisWorkerDicht(w);
  // En het resultaat zegt hardop dat het portaal dichtgaat en wat er met de klanten gebeurt.
  assert.ok(
    r.waarschuwingen.some((x) =>
      /KLANTPORTAAL VAN direct GAAT DICHT.*afgemeld.*nooit bant/.test(x),
    ),
    JSON.stringify(r.waarschuwingen),
  );
  assert.match(stap(r, "3.4 klanten van het gesloten klantportaal"), /niemand geband/);
});

test("droogloop: toont in beide richtingen wat er met de deur en de mail zou gebeuren en schrijft niets", async () => {
  const w = nepWolk();
  await richtIn(ARG, opzet(w, DEUR));
  const deurId = app(w, NAMEN.deur).id;

  // Van deur naar klantportaal.
  w.aanroepen.length = 0;
  let r = await richtIn({ ...ARG, droogloop: true }, opzet(w, PORTAAL));
  assert.deepEqual(w.schrijfacties(), []);
  // Zonder vinkje: de deur blijft, en de droogloop zegt wat het vinkje zou doen.
  assert.match(
    stap(r, "3.5 Access-app op de hostname"),
    new RegExp(`vb-direct \\(${deurId}\\) blijft staan.*zonder het vinkje.*veilig te herhalen`),
  );
  const mail = stap(r, "3.4 auth-config");
  assert.match(mail, /klantportaal: inloggen per mail aan/);
  assert.match(mail, /code van 10 cijfers.*15 minuten/);
  assert.match(mail, /Voorbeeld Direct <noreply@voorbeeldapps\.nl>/);
  assert.match(mail, /mailer_autoconfirm uit/);
  assert.match(mail, /captcha aan \(Turnstile/);
  assert.match(mail, /vb_portaal_voor_aanmelden.*vb_portaal_voor_token.*30 dagen/);
  assert.ok(!mail.includes("e-mail-inlog uit"));
  assert.ok(app(w, NAMEN.deur), "de deur staat er nog");
  assert.deepEqual(
    r.waarschuwingen.filter((x) => !/geen testdatabase/.test(x)),
    [],
  );
  // Met het vinkje, terwijl er nog niets klaarstaat: de droogloop zegt dat de echte run stopt.
  r = await richtIn({ ...MET_VINKJE, droogloop: true }, opzet(w, PORTAAL));
  assert.match(stap(r, "3.5 Access-app op de hostname"), /blijft staan: de echte run stopt/);
  assert.ok(
    r.waarschuwingen.some((x) =>
      /de echte run stopt hierop.*de deur gaat niet weg.*VITE_INLOGDIENST.*external_email_enabled/.test(
        x,
      ),
    ),
    JSON.stringify(r.waarschuwingen),
  );
  // Met het vinkje nadat een run zonder vinkje alles klaarzette: de deur staat gepland.
  await richtIn(ARG, opzet(w, PORTAAL));
  w.aanroepen.length = 0;
  r = await richtIn({ ...MET_VINKJE, droogloop: true }, opzet(w, PORTAAL));
  assert.deepEqual(w.schrijfacties(), []);
  assert.match(
    stap(r, "3.5 Access-app op de hostname"),
    new RegExp(
      `gepland: vb-direct \\(${deurId}\\) weghalen; verder wijzigt deze run niets.*open voor iedereen.*workers\\.dev en de previews blijven dicht`,
    ),
  );

  // En terug: de deur staat gepland.
  await naarPortaal(w);
  w.aanroepen.length = 0;
  r = await richtIn({ ...ARG, droogloop: true }, opzet(w, DEUR));
  assert.deepEqual(w.schrijfacties(), []);
  assert.equal(
    stap(r, "3.5 Access-app op de hostname"),
    "gepland: vb-direct op direct.voorbeeldapps.nl",
  );
  assert.match(stap(r, "3.4 auth-config"), /e-mail-inlog uit$/);
  assert.ok(
    r.waarschuwingen.some((x) =>
      /KLANTPORTAAL VAN direct GAAT DICHT.*Klanten kunnen daarna niet meer inloggen/.test(x),
    ),
    "de droogloop zegt dat het portaal dichtgaat",
  );

  // Een klantportaal dat al zonder deur staat: geen deur, en dat staat er ook.
  w.aanroepen.length = 0;
  r = await richtIn({ ...ARG, droogloop: true }, opzet(w, PORTAAL));
  assert.match(stap(r, "3.5 Access-app op de hostname"), /^geen deur\. klantportaal/);
});

test("droogloop zonder SMTP_WACHTWOORD: schrijft niets en waarschuwt dat de echte run stopt", async () => {
  const w = nepWolk();
  const r = await richtIn(
    { ...ARG, droogloop: true },
    opzet(w, PORTAAL, { smtpWachtwoord: undefined }),
  );
  assert.deepEqual(w.schrijfacties(), []);
  assert.ok(r.waarschuwingen.some((x) => /de echte run stopt hierop.*SMTP_WACHTWOORD/.test(x)));
});

// ---------------------------------------------------------------- workers.dev en previews

test("workers.dev en previews blijven dicht bij een klantportaal, ook na Toegang bijwerken en een gewijzigde groep", async () => {
  const w = nepWolk();
  await richtIn(ARG, opzet(w, DEUR));
  await naarPortaal(w);
  eisWorkerDicht(w);
  await werkToegangBij({ voorvoegsel: "vb-" }, opzet(w, PORTAAL));
  eisWorkerDicht(w);

  // Een tweede groep erbij: de Access op de Worker en de inlogdienst volgen, het domein
  // krijgt geen app terug.
  const meer = {
    groepen: { ...GROEPEN, extern: { adressen: ["hulp@bureau.nl"] } },
    apps: { direct: { ...PORTAAL.apps.direct, groepen: ["kantoor", "extern"] } },
  };
  await werkToegangBij({ voorvoegsel: "vb-" }, opzet(w, meer));
  const ids = ["vb-kantoor", "vb-extern"].map((n) => w.staat.policies.find((p) => p.name === n).id);
  for (const naam of [NAMEN.worker, NAMEN.inlog]) {
    assert.deepEqual(
      app(w, naam).policies.map((p) => p.id),
      ids,
      naam,
    );
  }
  assert.equal(app(w, NAMEN.deur), undefined);
  assert.deepEqual(
    app(w, NAMEN.worker).destinations.map((x) => x.uri),
    ["vb-direct.stagetwo-acc.workers.dev", "*-vb-direct.stagetwo-acc.workers.dev"],
  );
  // De redirect-lijst van Supabase noemt het subdomein van het account, nooit een wildcard.
  assert.ok(!auth(w).uri_allow_list.includes("*.workers.dev"));
});

test("workers.dev en previews: een klantportaal zonder Access op de Worker (oude app) krijgt die eerst, daarna pas gaat de deur weg", async () => {
  const w = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(w, DEUR));
  // Een app van vóór versie 21: de Access op de Worker ontbreekt.
  w.staat.apps = w.staat.apps.filter((a) => a.name !== NAMEN.worker);
  const deurId = app(w, NAMEN.deur).id;
  w.aanroepen.length = 0;
  await naarPortaal(w);
  eisWorkerDicht(w);
  assert.deepEqual(cfSchrijf(w), [
    "POST cf/access/apps self_hosted",
    `DELETE cf/access/apps/${deurId}`,
  ]);
});

test("workers.dev en previews: mislukt de Access op de Worker, dan blijft de deur staan", async () => {
  const w = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(w, DEUR));
  w.staat.apps = w.staat.apps.filter((a) => a.name !== NAMEN.worker);
  const kapot = nepWolk({
    workerBestaat: true,
    apps: w.staat.apps,
    policies: w.staat.policies,
    projecten: w.staat.projecten,
    providers: w.staat.providers,
    faal: (methode, pad) =>
      methode === "POST" && pad.endsWith("/access/apps") ? { status: 500, message: "stuk" } : null,
  });
  await assert.rejects(() => richtIn(ARG, opzet(kapot, PORTAAL)), /access\/apps gaf 500/);
  assert.ok(app(kapot, NAMEN.deur), "zonder Access op de Worker gaat de deur niet weg");
});

test("een klantportaal in de tijdelijke stand (alleen workers.dev) wordt geweigerd: dat adres blijft dicht", async () => {
  const w = nepWolk();
  await assert.rejects(
    () => richtIn({ ...ARG, hostname: null, stand: "tijdelijk" }, opzet(w, PORTAAL)),
    /gestopt zonder wijzigingen.*klantportaal direct: een klantportaal vraagt een eigen domein/,
  );
  assert.deepEqual(w.schrijfacties(), []);
});

test("een Access-app van iemand anders op het domein laat ook een klantportaal stoppen", async () => {
  const w = nepWolk({
    apps: [
      { id: "x", name: "met de hand", type: "self_hosted", domain: "direct.voorbeeldapps.nl" },
    ],
  });
  await assert.rejects(
    () => richtIn(ARG, opzet(w, PORTAAL)),
    /bewaakt direct\.voorbeeldapps\.nl al/,
  );
  assert.deepEqual(w.schrijfacties(), []);
});

test("van publieke paden naar klantportaal: de app met de bypass gaat weg, de bypass komt nergens anders terecht", async () => {
  const metPaden = {
    groepen: GROEPEN,
    apps: { direct: { groepen: ["kantoor"], publiek: ["/bekijk/*"] } },
  };
  const w = nepWolk();
  await richtIn(ARG, opzet(w, metPaden));
  assert.ok(app(w, NAMEN.publiek));
  const bypass = w.staat.policies.find((p) => p.decision === "bypass");
  await naarPortaal(w);
  assert.equal(app(w, NAMEN.publiek), undefined);
  assert.equal(app(w, NAMEN.deur), undefined);
  for (const naam of [NAMEN.worker, NAMEN.inlog]) {
    assert.ok(!app(w, naam).policies.some((p) => p.id === bypass.id), `${naam} zonder bypass`);
  }
  // Toegang bijwerken ruimt daarna de ongebruikte bypass-policy op.
  await werkToegangBij({ voorvoegsel: "vb-" }, opzet(w, PORTAAL));
  assert.ok(!w.staat.policies.some((p) => p.decision === "bypass"));
});

test("opruimen van een klantportaal laat niets achter", async () => {
  const w = nepWolk();
  await richtIn(ARG, opzet(w, PORTAAL));
  await ruimOp({ ...ARG, opruimen: true }, opzet(w, PORTAAL));
  assert.deepEqual(w.staat.apps, []);
  assert.deepEqual(w.staat.policies, []);
  assert.deepEqual(w.staat.projecten, []);
});

// ---------------------------------------------------------------- mail en de rem

/** De velden van UpdateAuthConfigBody (Management API, nagelopen op 13-11-2026) die we zetten. */
const BEKENDE_VELDEN = [
  "site_url",
  "uri_allow_list",
  "external_email_enabled",
  "mailer_autoconfirm",
  "mailer_allow_unverified_email_sign_ins",
  "security_manual_linking_enabled",
  "external_anonymous_users_enabled",
  ...Object.keys(MELDINGSMAILS_UIT),
  "smtp_host",
  "smtp_port",
  "smtp_user",
  "smtp_pass",
  "smtp_admin_email",
  "smtp_sender_name",
  "mailer_subjects_email_change",
  "mailer_templates_email_change_content",
  "mailer_subjects_reauthentication",
  "mailer_templates_reauthentication_content",
  "mailer_subjects_invite",
  "mailer_templates_invite_content",
  "mailer_secure_email_change_enabled",
  "smtp_max_frequency",
  "mailer_otp_length",
  "mailer_otp_exp",
  "mailer_subjects_confirmation",
  "mailer_templates_confirmation_content",
  "mailer_subjects_magic_link",
  "mailer_templates_magic_link_content",
  "mailer_subjects_recovery",
  "mailer_templates_recovery_content",
  "rate_limit_email_sent",
  "rate_limit_otp",
  "rate_limit_verify",
  "security_captcha_enabled",
  "security_captcha_provider",
  "security_captcha_secret",
  "hook_before_user_created_enabled",
  "hook_before_user_created_uri",
  "hook_custom_access_token_enabled",
  "hook_custom_access_token_uri",
  "sessions_inactivity_timeout",
];

test("mail: productie van een klantportaal krijgt inloggen per mail, Resend, code en link, de rem, de hooks en autoconfirm uit", async () => {
  const w = nepWolk();
  await naarPortaal(w);
  const a = auth(w);
  assert.equal(a.external_email_enabled, true);
  assert.equal(a.mailer_autoconfirm, false, "een adres moet eerst bewezen worden");
  assert.equal(a.mailer_allow_unverified_email_sign_ins, false);
  assert.equal(a.security_manual_linking_enabled, false, "geen inlog loskoppelen");
  assert.equal(a.smtp_host, "smtp.resend.com");
  assert.equal(a.smtp_port, "465");
  assert.equal(a.smtp_user, "resend");
  assert.equal(a.smtp_pass, SMTP);
  assert.equal(a.smtp_admin_email, "noreply@voorbeeldapps.nl");
  assert.equal(a.smtp_sender_name, "Voorbeeld Direct");
  assert.equal(a.mailer_otp_length, 10);
  assert.equal(a.mailer_otp_exp, 900);
  // De rem.
  assert.equal(a.rate_limit_email_sent, 100);
  assert.equal(a.smtp_max_frequency, 60);
  assert.equal(a.rate_limit_otp, 5);
  assert.equal(a.rate_limit_verify, 5);
  // De captcha staat standaard aan.
  assert.equal(a.security_captcha_enabled, true);
  assert.equal(a.security_captcha_provider, "turnstile");
  assert.equal(a.security_captcha_secret, TURNSTILE);
  // De hooks en de sessieduur.
  assert.equal(a.hook_before_user_created_enabled, true);
  assert.equal(a.hook_before_user_created_uri, `pg-functions://postgres/public/${HOOKS.aanmelden}`);
  assert.equal(a.hook_custom_access_token_enabled, true);
  assert.equal(a.hook_custom_access_token_uri, `pg-functions://postgres/public/${HOOKS.token}`);
  assert.equal(a.sessions_inactivity_timeout, 720);
  assert.deepEqual(SESSIE, { sessions_inactivity_timeout: 720 });
  // De adressen om naar terug te keren: het domein en de previews van dit account.
  assert.equal(a.site_url, "https://direct.voorbeeldapps.nl");
  assert.equal(
    a.uri_allow_list,
    "https://direct.voorbeeldapps.nl/**,https://pr-*-vb-direct.stagetwo-acc.workers.dev/**,https://actueel-vb-direct.stagetwo-acc.workers.dev/**",
  );
  // disable_signup blijft onaangeroerd, en er staat geen veld in dat de API niet kent.
  const gestuurd = w.aanroepen
    .filter((x) => x.methode === "PATCH" && /config\/auth$/.test(x.pad))
    .flatMap((x) => Object.keys(x.body));
  assert.ok(!gestuurd.includes("disable_signup"));
  assert.deepEqual(
    gestuurd.filter((k) => !BEKENDE_VELDEN.includes(k)),
    [],
  );
  // Productie toont beide manieren van inloggen en de widget; de previews (testdatabase)
  // alleen Cloudflare, zonder widget.
  assert.equal(KLANTPORTAAL_INLOGDIENST, "cloudflare,mailcode");
  assert.equal(w.staat.ghVariabelen.production.VITE_INLOGDIENST, "cloudflare,mailcode");
  assert.equal(w.staat.ghVariabelen.production.VITE_TURNSTILE_SITEKEY, SITEKEY);
  assert.equal(w.staat.ghVariabelen.preview.VITE_INLOGDIENST, "cloudflare");
  assert.equal(w.staat.ghVariabelen.preview.VITE_TURNSTILE_SITEKEY, undefined);
  assert.equal(w.staat.ghVariabelen.repo.PREVIEW_VITE_INLOGDIENST, "cloudflare");
});

test("mail: één sjabloon voor de drie soorten, in de vorm van het lokale sjabloon van de app: de code in id=code en een link met token_hash naar /login", async () => {
  const m = inlogmail("Voorbeeld Direct");
  assert.equal(INLOGLINK, "{{ .SiteURL }}/login?token_hash={{ .TokenHash }}&type=email");
  assert.equal(m.onderwerp, "Inloggen bij Voorbeeld Direct");
  assert.match(m.inhoud, /<span id="code">\{\{ \.Token \}\}<\/span>/);
  assert.ok(m.inhoud.includes(`<a id="link" href="${INLOGLINK}">`));
  assert.match(m.inhoud, /15 minuten/);
  // Nooit de link van Supabase zelf (die logt in bij het openen, ook door een linkscanner),
  // en nooit een adres dat de aanvrager kan sturen.
  assert.ok(!/ConfirmationURL|RedirectTo/.test(m.inhoud));
  const w = nepWolk();
  await richtIn(ARG, opzet(w, PORTAAL));
  for (const soort of ["confirmation", "magic_link", "recovery"]) {
    assert.equal(auth(w)[`mailer_templates_${soort}_content`], m.inhoud, soort);
    assert.equal(auth(w)[`mailer_subjects_${soort}`], m.onderwerp, soort);
  }
});

test("mail: de getallen van de rem en de code staan op één plek", () => {
  assert.deepEqual(REM, {
    rate_limit_email_sent: 100,
    smtp_max_frequency: 60,
    rate_limit_otp: 5,
    rate_limit_verify: 5,
  });
  assert.equal(CODE_GELDIG_SECONDEN, 900);
  assert.equal(CODE_LENGTE, 10);
});

test("mail: de naam van de afzender kan geen HTML of sjabloonopdracht worden", () => {
  const m = inlogmail("Jansen & Zn. (Direct)");
  assert.match(m.inhoud, /Inloggen bij Jansen &amp; Zn\. \(Direct\)/);
  assert.ok(!m.inhoud.includes("Jansen & Zn"));
  assert.equal(m.onderwerp, "Inloggen bij Jansen & Zn. (Direct)");
  assert.throws(() => inlogmail("x {{ .Token }}"), /ongeldig teken/);
  assert.throws(() => inlogmail("<b>x</b>"), /ongeldig teken/);
  const afzender = { adres: "a@b.nl", naam: "A" };
  assert.throws(() => klantportaalInstellingen({ afzender }), /SMTP_WACHTWOORD ontbreekt/);
  assert.throws(
    () => klantportaalInstellingen({ afzender, smtpWachtwoord: "x", hooks: HOOKS }),
    /TURNSTILE_GEHEIM ontbreekt/,
  );
  assert.throws(
    () => klantportaalInstellingen({ afzender, smtpWachtwoord: "x", captchaGeheim: "y" }),
    /hookfuncties ontbreken/,
  );
});

test("mail: zonder naam in de afzender is de naam die van de app", async () => {
  const w = nepWolk();
  const t = {
    groepen: GROEPEN,
    apps: {
      direct: {
        groepen: ["kantoor"],
        klantportaal: true,
        afzender: "Noreply@VoorbeeldApps.nl",
        turnstile_sitekey: SITEKEY,
      },
    },
  };
  await richtIn(ARG, opzet(w, t));
  assert.equal(auth(w).smtp_admin_email, "noreply@voorbeeldapps.nl");
  assert.equal(auth(w).smtp_sender_name, "direct");
});

test("ontbrekend SMTP-secret: de inrichting stopt vóór de eerste wijziging, en de deur blijft staan", async () => {
  // Een nieuwe app: er wordt niets aangemaakt, ook geen Supabase-project.
  const leeg = nepWolk();
  await assert.rejects(
    () => richtIn(ARG, opzet(leeg, PORTAAL, { smtpWachtwoord: undefined })),
    /gestopt zonder wijzigingen: klantportaal direct: het secret SMTP_WACHTWOORD ontbreekt/,
  );
  assert.deepEqual(leeg.schrijfacties(), []);
  assert.deepEqual(leeg.staat.projecten, []);

  // Een bestaande app met een deur: de deur staat er nog en mail is niet aangezet.
  const w = nepWolk();
  await richtIn(ARG, opzet(w, DEUR));
  const voor = structuredClone({
    apps: w.staat.apps,
    auth: w.staat.auth,
    gh: w.staat.ghVariabelen,
  });
  w.aanroepen.length = 0;
  for (const leegGeheim of [undefined, "", null]) {
    await assert.rejects(
      () => richtIn(ARG, opzet(w, PORTAAL, { smtpWachtwoord: leegGeheim })),
      /SMTP_WACHTWOORD ontbreekt/,
    );
  }
  assert.deepEqual(w.schrijfacties(), []);
  assert.deepEqual(
    structuredClone({ apps: w.staat.apps, auth: w.staat.auth, gh: w.staat.ghVariabelen }),
    voor,
  );
  assert.ok(app(w, NAMEN.deur));
  assert.equal(auth(w).external_email_enabled, false);
});

test("mislukt het aanzetten van de mail bij Supabase, dan blijft de deur staan", async () => {
  const w = nepWolk();
  await richtIn(ARG, opzet(w, DEUR));
  const kapot = nepWolk({
    workerBestaat: true,
    apps: w.staat.apps,
    policies: w.staat.policies,
    projecten: w.staat.projecten,
    providers: w.staat.providers,
    faal: (methode, pad) =>
      methode === "PATCH" && pad.endsWith("/config/auth")
        ? { status: 400, message: "smtp geweigerd" }
        : null,
  });
  await assert.rejects(() => richtIn(ARG, opzet(kapot, PORTAAL)), /config\/auth gaf 400/);
  assert.ok(app(kapot, NAMEN.deur), "geen mail, dan ook geen open domein");
});

test("geheimen: het SMTP-wachtwoord staat alleen in de aanroep naar Supabase, nooit in het resultaat of het logboek", async () => {
  const w = nepWolk();
  const d = opzet(w, PORTAAL);
  const r = await richtIn(ARG, d);
  assert.ok(!JSON.stringify(r).includes(SMTP), "niet in het resultaat");
  assert.ok(d.geheimen.includes(SMTP), "gemaskeerd voor het logboek");
  assert.ok(!uitvoerRegel(r, d.geheimen).includes(SMTP));
  const met = w.aanroepen.filter((a) => JSON.stringify(a.body ?? "").includes(SMTP));
  assert.equal(met.length, 1);
  assert.equal(met[0].methode, "PATCH");
  assert.match(met[0].pad, /^api\.supabase\.com\/v1\/projects\/[^/]+\/config\/auth$/);
  assert.ok(!w.aanroepen.some((a) => a.soort === "gh" && String(a.invoer).includes(SMTP)));
  // Ook een foutmelding van Supabase noemt het wachtwoord niet.
  const kapot = nepWolk({
    faal: (methode, pad) =>
      methode === "PATCH" && pad.endsWith("/config/auth") ? { status: 400, message: "nee" } : null,
  });
  await assert.rejects(
    () => richtIn(ARG, opzet(kapot, PORTAAL)),
    (fout) => !fout.message.includes(SMTP),
  );
});

test("captcha: staat standaard aan; zonder geheim stopt de inrichting vóór de eerste wijziging", async () => {
  const leeg = nepWolk();
  await assert.rejects(
    () => richtIn(ARG, opzet(leeg, PORTAAL, { captchaGeheim: undefined })),
    /gestopt zonder wijzigingen.*de captcha staat aan \(de standaard bij een klantportaal\).*TURNSTILE_GEHEIM ontbreekt/,
  );
  assert.deepEqual(leeg.schrijfacties(), []);
  const droog = await richtIn(
    { ...ARG, droogloop: true },
    opzet(leeg, PORTAAL, { captchaGeheim: undefined }),
  );
  assert.ok(
    droog.waarschuwingen.some((x) => /de echte run stopt hierop.*TURNSTILE_GEHEIM/.test(x)),
  );

  // Een nieuwe app, of een app achter de deur: de captcha gaat aan in dezelfde aanroep als het
  // inloggen per mail. Er is geen moment waarop de mail openstaat zonder captcha.
  const w = nepWolk();
  await richtIn(ARG, opzet(w, DEUR));
  const d = opzet(w, PORTAAL);
  const r = await richtIn(ARG, d);
  const patch = w.aanroepen.find((a) => a.methode === "PATCH" && a.body?.external_email_enabled);
  assert.equal(patch.body.security_captcha_enabled, true, "in dezelfde aanroep als de mail");
  assert.equal(auth(w).security_captcha_enabled, true);
  assert.equal(auth(w).security_captcha_provider, "turnstile");
  assert.equal(auth(w).security_captcha_secret, TURNSTILE);
  assert.match(stap(r, "3.4 captcha"), /^aan \(Turnstile\)/);
  assert.ok(!uitvoerRegel(r, d.geheimen).includes(TURNSTILE));
  assert.ok(!JSON.stringify(r).includes(TURNSTILE));
  assert.ok(!r.waarschuwingen.some((x) => /captcha staat uit/.test(x)));
  // Het geheim gaat alleen naar Supabase; naar GitHub gaat alleen de openbare sleutel.
  assert.ok(!w.aanroepen.some((a) => a.soort === "gh" && String(a.invoer).includes(TURNSTILE)));
});

test("captcha: op een portaal dat live is verandert een run zonder vinkje niets aan de captcha; een nieuwe widget gaat pas in met het vinkje, na de uitrol", async () => {
  const w = nepWolk();
  await richtIn(ARG, opzet(w, DEUR));
  await naarPortaal(w);
  assert.equal(app(w, NAMEN.deur), undefined);
  assert.equal(auth(w).security_captcha_secret, TURNSTILE);

  // Een nieuwe widget (andere sleutel, ander geheim). Zonder vinkje: de openbare sleutel staat
  // klaar voor de app, het oude geheim blijft in Supabase. Niemand wordt buitengesloten zolang
  // de app nog met de oude widget draait.
  const nieuw = {
    groepen: GROEPEN,
    apps: { direct: { ...PORTAAL.apps.direct, turnstile_sitekey: "0x4AAAAAAANieuweSleutel" } },
  };
  const nieuwGeheim = "0x4NieuwGeheimVanTurnstile";
  // Het vinkje vóór de sleutel klaarstond wordt geweigerd, zonder wijzigingen.
  w.aanroepen.length = 0;
  await assert.rejects(
    () => richtIn(MET_VINKJE, opzet(w, nieuw, { captchaGeheim: nieuwGeheim })),
    /het portaal is live.*VITE_TURNSTILE_SITEKEY in omgeving production is niet de sleutel uit toegang\.json.*Draai App inrichten eerst zonder vinkje/,
  );
  assert.deepEqual(w.schrijfacties(), []);
  for (let keer = 0; keer < 2; keer += 1) {
    const r = await richtIn(ARG, opzet(w, nieuw, { captchaGeheim: nieuwGeheim }));
    assert.equal(auth(w).security_captcha_enabled, true);
    assert.equal(auth(w).security_captcha_secret, TURNSTILE, "nog het oude geheim");
    assert.match(stap(r, "3.4 captcha"), /niet aangeraakt: het portaal is live \(nu aan\)/);
    assert.ok(
      r.waarschuwingen.some((x) => /is live: deze run verandert niets aan de captcha/.test(x)),
    );
  }
  assert.equal(w.staat.ghVariabelen.production.VITE_TURNSTILE_SITEKEY, "0x4AAAAAAANieuweSleutel");
  // De owner rolt de app uit en draait met het vinkje: nu gaat het nieuwe geheim in.
  await richtIn(MET_VINKJE, opzet(w, nieuw, { captchaGeheim: nieuwGeheim }));
  assert.equal(auth(w).security_captcha_secret, nieuwGeheim);
  assert.equal(auth(w).security_captcha_enabled, true);
});

test('captcha: uitzetten kan alleen met een uitdrukkelijke "captcha": false, en dan waarschuwt elke run', async () => {
  const uit = {
    groepen: GROEPEN,
    apps: { direct: { ...PORTAAL.apps.direct, captcha: false } },
  };
  const w = nepWolk();
  await naarPortaal(w);
  assert.equal(w.staat.ghVariabelen.production.VITE_TURNSTILE_SITEKEY, SITEKEY);
  assert.equal(auth(w).security_captcha_enabled, true);

  w.aanroepen.length = 0;
  const r = await richtIn(ARG, opzet(w, uit, { captchaGeheim: undefined }));
  assert.equal(
    auth(w).security_captcha_enabled,
    false,
    "uit gaat meteen: dat sluit niemand buiten",
  );
  assert.ok(!w.aanroepen.some((a) => JSON.stringify(a.body ?? "").includes(TURNSTILE)));
  assert.ok(
    r.waarschuwingen.some((x) => /captcha staat uit.*mailgrens/.test(x)),
    JSON.stringify(r.waarschuwingen),
  );
  // De app toont de widget dan ook niet meer.
  assert.equal(w.staat.ghVariabelen.production.VITE_TURNSTILE_SITEKEY, undefined);
  const droog = await richtIn({ ...ARG, droogloop: true }, opzet(w, uit));
  assert.match(stap(droog, "3.4 auth-config"), /captcha UIT/);
  assert.ok(droog.waarschuwingen.some((x) => /captcha staat uit/.test(x)));
  // En weer aan, op een portaal dat live is: zonder vinkje blijft hij uit (met een
  // waarschuwing), met het vinkje gaat hij aan.
  const r2 = await richtIn(ARG, opzet(w, PORTAAL));
  assert.equal(auth(w).security_captcha_enabled, false);
  assert.ok(r2.waarschuwingen.some((x) => /is live en de captcha staat UIT/.test(x)));
  await richtIn(MET_VINKJE, opzet(w, PORTAAL));
  assert.equal(auth(w).security_captcha_enabled, true);
});

// ---------------------------------------------------------------- de testdatabase

test("de testdatabase van een klantportaal blijft zoals bij elke app: e-mail alleen voor testaccounts, geen SMTP, autoconfirm aan", async () => {
  const w = nepWolk();
  const gewoon = nepWolk();
  const arg = { ...ARG, testdatabase: true };
  await richtIn(arg, opzet(w, PORTAAL));
  await richtIn(arg, opzet(gewoon, DEUR));
  const test = auth(w, "vb-direct-test");
  assert.deepEqual(test, auth(gewoon, "vb-direct-test"), "exact als bij een gewone app");
  assert.equal(test.mailer_autoconfirm, true);
  assert.equal(test.hook_before_user_created_enabled, true);
  assert.ok(!Object.keys(test).some((k) => /^smtp_|rate_limit|captcha|mailer_otp/.test(k)));
  // Het SMTP-wachtwoord gaat alleen naar productie.
  const ref = project(w, "vb-direct-test").ref;
  assert.ok(
    !w.aanroepen.some(
      (a) => (a.pad ?? "").includes(ref) && JSON.stringify(a.body ?? "").includes(SMTP),
    ),
  );
  // De hook van de testdatabase is dezelfde SQL.
  const sql = (x) =>
    x.staat.sqlOp.filter((q) => q.ref === project(x, "vb-direct-test").ref).map((q) => q.query);
  assert.deepEqual(sql(w), sql(gewoon));
  assert.equal(w.staat.ghVariabelen.repo.PREVIEW_VITE_INLOGDIENST, "cloudflare");
});

// ---------------------------------------------------------------- toegang bijwerken

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const cf = (adres) => ({ provider: "custom:cloudflare", identity_data: { email: adres } });
const mail = (adres) => ({ provider: "email", identity_data: { email: adres } });
const GEBAND = "2126-01-01T00:00:00Z";

/** Klanten en medewerkers door elkaar, zoals de productiedatabase van een klantportaal. */
const MENSEN = () => [
  // Klanten: alleen per mail. Hun adres staat in geen enkele groep.
  {
    id: ID(1),
    email: "inkoop@bloemist.nl",
    identities: [mail("inkoop@bloemist.nl")],
    app_metadata: { provider: "email", providers: ["email"] },
  },
  {
    id: ID(2),
    email: "piet@tuincentrum.be",
    identities: [mail("piet@tuincentrum.be")],
    app_metadata: { provider: "email", providers: ["email"] },
  },
  // Een klant die de app of de owner zelf heeft geblokkeerd: blijft geblokkeerd.
  {
    id: ID(3),
    email: "wanbetaler@handel.nl",
    identities: [mail("wanbetaler@handel.nl")],
    app_metadata: { providers: ["email"] },
    banned_until: GEBAND,
  },
  // Een klant zonder metadata (door de app of de admin-API gemaakt).
  { id: ID(4), email: "oud@klant.de" },
  // Medewerkers via Cloudflare.
  {
    id: ID(5),
    email: "anna@voorbeeld.nl",
    identities: [cf("anna@voorbeeld.nl")],
    app_metadata: { provider: "custom:cloudflare", providers: ["custom:cloudflare"] },
  },
  // Vertrokken: staat in uitsluiten.
  {
    id: ID(6),
    email: "oud@voorbeeld.nl",
    identities: [cf("oud@voorbeeld.nl")],
    app_metadata: { provider: "custom:cloudflare", providers: ["custom:cloudflare"] },
  },
  // Vertrokken en eerder al ingetrokken.
  {
    id: ID(7),
    email: "ex@bureau.nl",
    identities: [cf("ex@bureau.nl")],
    app_metadata: { providers: ["custom:cloudflare"] },
    banned_until: GEBAND,
  },
  // Een hulpkracht van buiten die niet meer in een groep staat.
  {
    id: ID(8),
    email: "hulp@bureau.nl",
    identities: [cf("hulp@bureau.nl")],
    app_metadata: { providers: ["custom:cloudflare"] },
  },
];

async function portaalMet(gebruikers) {
  const w = nepWolk({ gebruikers });
  await richtIn(ARG, opzet(w, PORTAAL));
  w.aanroepen.length = 0;
  return w;
}

const bans = (w) =>
  w.aanroepen
    .filter((a) => a.methode === "updateUserById" && a.body.ban_duration !== "none")
    .map((a) => a.body.id);
const afgemeld = (w) =>
  w.staat.sql
    .filter((q) => q.startsWith("delete from auth.sessions"))
    .map((q) => q.match(/'([^']+)'/)[1]);

test("geen ban voor klanten: Toegang bijwerken laat bij een klantportaal elk account zonder Cloudflare-inlog met rust", async () => {
  const w = await portaalMet(MENSEN());
  const r = await werkToegangBij({ voorvoegsel: "vb-" }, opzet(w, PORTAAL));
  for (const n of [1, 2, 3, 4]) {
    assert.ok(!bans(w).includes(ID(n)), `klant ${n} is niet geband`);
    assert.ok(!afgemeld(w).includes(ID(n)), `klant ${n} is niet afgemeld`);
  }
  // Geen enkele aanroep noemt een klant, ook geen opheffing van de ban van nummer 3.
  const geraakt = w.aanroepen.filter((a) => a.methode === "updateUserById").map((a) => a.body.id);
  assert.deepEqual(geraakt.sort(), [ID(6), ID(8)]);
  assert.equal(w.staat.gebruikers.find((g) => g.id === ID(3)).banned_until, GEBAND);
  assert.equal(w.staat.gebruikers.find((g) => g.id === ID(1)).banned_until, undefined);
  assert.deepEqual(r.klanten, { direct: 4 });
  assert.ok(!JSON.stringify(r.ingetrokken).includes("bloemist"));
});

test("geen ban voor klanten: ook niet met honderden klanten en geen enkele medewerker", async () => {
  const klanten = Array.from({ length: 1500 }, (_, i) => ({
    id: ID(1000 + i),
    email: `klant${i}@bedrijf${i}.nl`,
    app_metadata: { provider: "email", providers: ["email"] },
  }));
  const w = await portaalMet(klanten);
  const r = await werkToegangBij({ voorvoegsel: "vb-" }, opzet(w, PORTAAL));
  assert.deepEqual(bans(w), []);
  assert.deepEqual(afgemeld(w), []);
  assert.deepEqual(r.klanten, { direct: 1500 });
  assert.deepEqual(r.ingetrokken, {});
});

test("geen ban voor klanten: een klant met een adres op het domein van de medewerkers, per mail ingelogd, is en blijft een gewone klant", async () => {
  const w = await portaalMet([
    {
      id: ID(1),
      email: "stagiair@voorbeeld.nl",
      identities: [mail("stagiair@voorbeeld.nl")],
      app_metadata: { providers: ["email"] },
    },
    // Uitgesloten adres, maar alleen per mail: geen medewerkersaccount, dus geen oordeel.
    {
      id: ID(2),
      email: "oud@voorbeeld.nl",
      identities: [mail("oud@voorbeeld.nl")],
      app_metadata: { providers: ["email"] },
    },
  ]);
  const r = await werkToegangBij({ voorvoegsel: "vb-" }, opzet(w, PORTAAL));
  assert.deepEqual(bans(w), []);
  assert.deepEqual(r.klanten, { direct: 2 });
});

test("wel ban voor een vertrokken medewerker: ban én afmelden, ook bij een klantportaal", async () => {
  const w = await portaalMet(MENSEN());
  const r = await werkToegangBij({ voorvoegsel: "vb-" }, opzet(w, PORTAAL));
  assert.deepEqual(bans(w).sort(), [ID(6), ID(8)]);
  assert.deepEqual(afgemeld(w).sort(), [ID(6), ID(8)]);
  assert.deepEqual(r.ingetrokken, { direct: ["oud@voorbeeld.nl", "hulp@bureau.nl"] });
  for (const a of w.aanroepen.filter((x) => x.methode === "updateUserById")) {
    assert.equal(a.body.ban_duration, "876000h");
  }
  // De blijvende medewerker en de al ingetrokken medewerker: geen aanroep.
  assert.ok(!bans(w).includes(ID(5)));
  assert.ok(!bans(w).includes(ID(7)));
  // Een tweede run doet niets meer.
  w.aanroepen.length = 0;
  w.staat.sql.length = 0;
  await werkToegangBij({ voorvoegsel: "vb-" }, opzet(w, PORTAAL));
  assert.deepEqual(bans(w), []);
  assert.deepEqual(afgemeld(w), []);
});

test("wel ban voor een vertrokken medewerker: de Cloudflare-inlog komt uit de database, want de gebruikerslijst geeft geen identiteiten mee", async () => {
  // Alleen de identiteit zegt dat dit een medewerker is: geen app_metadata.
  const w = await portaalMet([
    { id: ID(1), email: "oud@voorbeeld.nl", identities: [cf("oud@voorbeeld.nl")] },
    { id: ID(2), email: "klant@elders.nl", identities: [mail("klant@elders.nl")] },
  ]);
  const r = await werkToegangBij({ voorvoegsel: "vb-" }, opzet(w, PORTAAL));
  assert.deepEqual(bans(w), [ID(1)]);
  assert.deepEqual(r.klanten, { direct: 1 });
  // Eén leesvraag naar auth.identities op het productieproject, vóór de eerste ban.
  const vragen = w.aanroepen.filter((a) => a.body?.query === CLOUDFLARE_IDENTITEITEN_SQL);
  assert.equal(vragen.length, 1);
  assert.ok(vragen[0].pad.includes(project(w).ref));
  assert.match(CLOUDFLARE_IDENTITEITEN_SQL, /^select /);
  assert.ok(!/insert|update|delete|;.*;/i.test(CLOUDFLARE_IDENTITEITEN_SQL));
  assert.ok(
    w.aanroepen.indexOf(vragen[0]) < w.aanroepen.findIndex((a) => a.methode === "updateUserById"),
  );
});

test("wel ban voor een vertrokken medewerker: ook als de database de identiteit niet teruggeeft maar Supabase hem als Cloudflare-account kent", async () => {
  const w = await portaalMet([
    {
      id: ID(1),
      email: "oud@voorbeeld.nl",
      app_metadata: { provider: "email", providers: ["email", "custom:cloudflare"] },
    },
    { id: ID(2), email: "hulp@bureau.nl", app_metadata: { provider: "custom:cloudflare" } },
    {
      id: ID(3),
      email: "klant@elders.nl",
      app_metadata: { provider: "email", providers: ["email"] },
    },
  ]);
  w.staat.identiteitenAntwoord = [];
  const r = await werkToegangBij({ voorvoegsel: "vb-" }, opzet(w, PORTAAL));
  assert.deepEqual(bans(w).sort(), [ID(1), ID(2)]);
  assert.deepEqual(r.klanten, { direct: 1 });
});

test("een account met een Cloudflare- én een e-mailinlog: een vertrokken medewerker gaat helemaal dicht, een blijvende blijft", async () => {
  const w = await portaalMet([
    // Was medewerker, logde ook per mail in. Uit de groep: het hele account dicht.
    {
      id: ID(1),
      email: "oud@voorbeeld.nl",
      identities: [mail("oud@voorbeeld.nl"), cf("oud@voorbeeld.nl")],
      app_metadata: { provider: "email", providers: ["email", "custom:cloudflare"] },
    },
    // Is medewerker en logde ook per mail in: blijft.
    {
      id: ID(2),
      email: "anna@voorbeeld.nl",
      identities: [mail("anna@voorbeeld.nl"), cf("anna@voorbeeld.nl")],
      app_metadata: { provider: "email", providers: ["email", "custom:cloudflare"] },
    },
    // Zette zelf een ander adres op zijn account; Cloudflare kent hem als oud@voorbeeld.nl.
    {
      id: ID(3),
      email: "prive@gmail.com",
      identities: [cf("Oud@Voorbeeld.nl")],
      app_metadata: { providers: ["custom:cloudflare"] },
    },
    // Medewerker met een eigen adres op het account: Cloudflare kent hem als anna@voorbeeld.nl.
    {
      id: ID(4),
      email: "anna.prive@gmail.com",
      identities: [cf("anna@voorbeeld.nl")],
      app_metadata: { providers: ["custom:cloudflare"] },
    },
  ]);
  const r = await werkToegangBij({ voorvoegsel: "vb-" }, opzet(w, PORTAAL));
  assert.deepEqual(bans(w).sort(), [ID(1), ID(3)]);
  assert.deepEqual(afgemeld(w).sort(), [ID(1), ID(3)]);
  assert.deepEqual(r.ingetrokken, { direct: ["oud@voorbeeld.nl", "prive@gmail.com"] });
  assert.deepEqual(r.klanten, { direct: 0 }, "geen van de vier telt als klant");
  // Dat het hele account dicht is, ook de klantkant, staat in het resultaat.
  const ookPerMail = r.waarschuwingen.filter((x) =>
    /kon met hetzelfde account ook per mail/.test(x),
  );
  assert.equal(ookPerMail.length, 1);
  assert.match(ookPerMail[0], /oud@voorbeeld\.nl/);
});

test("een Cloudflare-account zonder eigen adres wordt beoordeeld op het adres van Cloudflare, en gemeld", async () => {
  const w = await portaalMet([
    // De medewerker maakte eerst per mail een klantaccount; Cloudflare gaf hem daarna een
    // tweede account zonder adres.
    {
      id: ID(1),
      email: "anna@voorbeeld.nl",
      identities: [mail("anna@voorbeeld.nl")],
      app_metadata: { providers: ["email"] },
    },
    {
      id: ID(2),
      identities: [cf("anna@voorbeeld.nl")],
      app_metadata: { providers: ["custom:cloudflare"] },
    },
    // Hetzelfde, maar van iemand die niet meer in de groep staat: dicht.
    {
      id: ID(3),
      identities: [cf("oud@voorbeeld.nl")],
      app_metadata: { providers: ["custom:cloudflare"] },
    },
  ]);
  const r = await werkToegangBij({ voorvoegsel: "vb-" }, opzet(w, PORTAAL));
  assert.deepEqual(bans(w), [ID(3)]);
  assert.deepEqual(afgemeld(w), [ID(3)]);
  assert.deepEqual(r.klanten, { direct: 1 });
  assert.ok(
    r.waarschuwingen.some((x) =>
      /anna@voorbeeld\.nl heeft via Cloudflare een account zonder adres/.test(x),
    ),
    JSON.stringify(r.waarschuwingen),
  );
});

test("geeft de database geen lijst terug op de vraag naar de Cloudflare-inlogs, dan bant Toegang bijwerken bij dat portaal niemand en eindigt de run rood", async () => {
  for (const raar of [{ rows: [] }, "ok", null, [{ email: "x@y.nl" }]]) {
    const w = await portaalMet(MENSEN());
    w.staat.identiteitenAntwoord = raar;
    const r = await werkToegangBij({ voorvoegsel: "vb-" }, opzet(w, PORTAAL));
    assert.match(
      r.fouten.join(" "),
      /direct: het intrekken is niet.*auth\.identities.*er is niets ingetrokken/,
    );
    assert.equal(eindstatus("toegang", r).status, "mislukt");
    assert.deepEqual(bans(w), []);
    assert.deepEqual(afgemeld(w), []);
  }
});

test("een medewerker die weer in de groep komt, krijgt bij een klantportaal de ban opgeheven; een geblokkeerde klant niet", async () => {
  const w = await portaalMet(MENSEN());
  const terug = {
    groepen: { kantoor: { domeinen: ["voorbeeld.nl"], adressen: ["ex@bureau.nl"] } },
    apps: PORTAAL.apps,
  };
  const r = await werkToegangBij({ voorvoegsel: "vb-" }, opzet(w, terug));
  const opgeheven = w.aanroepen
    .filter((a) => a.methode === "updateUserById" && a.body.ban_duration === "none")
    .map((a) => a.body.id);
  assert.deepEqual(opgeheven, [ID(7)]);
  assert.deepEqual(r.toegelaten, { direct: ["ex@bureau.nl"] });
  assert.equal(w.staat.gebruikers.find((g) => g.id === ID(3)).banned_until, GEBAND);
});

test("Toegang bijwerken haalt de deur niet zelf weg: staat hij er nog, dan zegt hij dat App inrichten dat doet", async () => {
  const w = nepWolk({ gebruikers: MENSEN() });
  await richtIn(ARG, opzet(w, DEUR));
  const deurId = app(w, NAMEN.deur).id;
  w.aanroepen.length = 0;
  const droog = await werkToegangBij({ voorvoegsel: "vb-", droogloop: true }, opzet(w, PORTAAL));
  assert.deepEqual(w.schrijfacties(), []);
  assert.ok(
    droog.acties.some((a) => /klantportaal direct: de deur vb-direct staat er nog/.test(a)),
  );
  const r = await werkToegangBij({ voorvoegsel: "vb-" }, opzet(w, PORTAAL));
  assert.equal(app(w, NAMEN.deur)?.id, deurId, "de deur staat er nog");
  assert.ok(r.acties.some((a) => /dat doet alleen App inrichten met het vinkje/.test(a)));
  assert.equal(auth(w).external_email_enabled, false, "en mail staat nog uit");
  // De klanten zijn nu al veilig: het bestand zegt klantportaal.
  assert.deepEqual(bans(w).sort(), [ID(6), ID(8)]);
});

test("de testdatabase van een klantportaal: Toegang bijwerken trekt daar in zoals bij elke app, met de testaccounts ongemoeid", async () => {
  const w = nepWolk();
  await richtIn({ ...ARG, testdatabase: true }, opzet(w, PORTAAL));
  const url = (naam) => `https://${project(w, naam).ref}.supabase.co`;
  w.staat.gebruikersOp[url("vb-direct")] = MENSEN();
  w.staat.gebruikersOp[url("vb-direct-test")] = [
    { id: ID(21), email: "anna@voorbeeld.nl" },
    { id: ID(22), email: "vreemd@elders.nl" },
    { id: ID(23), email: "testgebruiker@stagetwo.nl" },
  ];
  w.aanroepen.length = 0;
  const r = await werkToegangBij({ voorvoegsel: "vb-" }, opzet(w, PORTAAL));
  assert.deepEqual(r.ingetrokken, {
    direct: ["oud@voorbeeld.nl", "hulp@bureau.nl"],
    "direct (test)": ["vreemd@elders.nl"],
  });
  assert.deepEqual(r.klanten, { direct: 4 });
  // De vraag naar auth.identities gaat alleen naar productie.
  const vragen = w.aanroepen.filter((a) => a.body?.query === CLOUDFLARE_IDENTITEITEN_SQL);
  assert.deepEqual(
    vragen.map((a) => a.pad.includes(project(w, "vb-direct-test").ref)),
    [false],
  );
});

test("klantportaal geldt per app: een gewone app in hetzelfde bestand trekt in zoals altijd", async () => {
  const twee = {
    groepen: GROEPEN,
    apps: { direct: PORTAAL.apps.direct, intern: ["kantoor"] },
  };
  const w = nepWolk();
  await richtIn(ARG, opzet(w, twee));
  await richtIn(
    { ...ARG, app: "intern", hostname: "intern.voorbeeldapps.nl", worker: "vb-intern" },
    opzet(w, twee),
  );
  assert.ok(app(w, "vb-intern"), "de gewone app heeft zijn deur");
  assert.equal(app(w, "vb-direct"), undefined);
  assert.equal(auth(w, "vb-intern").external_email_enabled, false);
  assert.equal(auth(w, "vb-intern").mailer_autoconfirm, true);
  const url = (naam) => `https://${project(w, naam).ref}.supabase.co`;
  w.staat.gebruikersOp[url("vb-direct")] = [{ id: ID(1), email: "klant@elders.nl" }];
  w.staat.gebruikersOp[url("vb-intern")] = [{ id: ID(2), email: "klant@elders.nl" }];
  w.aanroepen.length = 0;
  const r = await werkToegangBij({ voorvoegsel: "vb-" }, opzet(w, twee));
  assert.deepEqual(r.ingetrokken, { intern: ["klant@elders.nl"] });
  assert.deepEqual(r.klanten, { direct: 1 });
  assert.deepEqual(bans(w), [ID(2)]);
});

test("terug naar een gewone app bant geen enkele klant: vóór App inrichten slaat de rem aan (medewerkers wel, klanten niet, rood), erna zijn de klanten afgemeld en gemarkeerd", async () => {
  const w = await portaalMet(MENSEN());
  // Het bestand zegt: gewone app. App inrichten heeft nog niet gedraaid: mail staat nog aan.
  const r = await werkToegangBij({ voorvoegsel: "vb-" }, opzet(w, DEUR));
  // De vertrokken medewerkers gaan er gewoon uit; geen klant wordt geraakt.
  assert.deepEqual(bans(w).sort(), [ID(6), ID(8)]);
  assert.deepEqual(afgemeld(w).sort(), [ID(6), ID(8)]);
  assert.deepEqual(r.klanten, { direct: 4 });
  assert.match(
    r.fouten.join(" "),
    /direct: wacht op App inrichten.*de 4 klantaccounts zijn met rust gelaten.*Draai App inrichten/,
  );
  assert.equal(eindstatus("toegang", r).status, "mislukt", "de run eindigt rood");
  // App inrichten sluit het portaal: deur terug, mail uit, klanten afgemeld en gemarkeerd.
  const dicht = await richtIn(ARG, opzet(w, DEUR));
  assert.match(
    stap(dicht, "3.4 klanten van het gesloten klantportaal"),
    /^4 klantaccounts.*niemand geband/,
  );
  assert.ok(w.staat.sql.some((q) => /^delete from auth\.sessions where user_id not in/.test(q)));
  // Daarna is het een gewone app, en nog steeds wordt geen klant geband: ook niet na tien runs.
  w.aanroepen.length = 0;
  let r2;
  for (let keer = 0; keer < 10; keer += 1) {
    r2 = await werkToegangBij({ voorvoegsel: "vb-" }, opzet(w, DEUR));
  }
  assert.deepEqual(bans(w), []);
  assert.deepEqual(r2.klanten, { direct: 4 });
  assert.equal(r2.fouten, undefined, "en de run is weer groen");
  assert.equal(eindstatus("toegang", r2).status, "gelukt");
});
