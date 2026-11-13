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
  KLANTPORTAAL_INLOGDIENST,
  richtIn,
  ruimOp,
  uitvoerRegel,
  werkToegangBij,
} from "./inrichten-cloudflare.mjs";
import { cloudflareClient } from "./lib/cloudflare.mjs";
import {
  CODE_GELDIG_SECONDEN,
  inlogmail,
  klantportaalInstellingen,
  REM,
  supabaseBeheer,
} from "./lib/supabase.mjs";
import { CLOUDFLARE_IDENTITEITEN_SQL } from "./lib/toegang.mjs";
import { nepWolk } from "./nep-wolk.mjs";

const GROEPEN = { kantoor: { domeinen: ["winco.nl"], uitsluiten: ["oud@winco.nl"] } };
const AFZENDER = "Winco Direct <noreply@wincoapps.com>";
const DEUR = { groepen: GROEPEN, apps: { direct: ["kantoor"] } };
const PORTAAL = {
  groepen: GROEPEN,
  apps: { direct: { groepen: ["kantoor"], klantportaal: true, afzender: AFZENDER } },
};
const ARG = {
  app: "direct",
  hostname: "direct.wincoapps.com",
  worker: "wi-direct",
  repo: "Winco-Holland-B-V/direct",
  voorvoegsel: "wi-",
  droogloop: false,
};
const SMTP = "re_GeheimeSleutelVanResend123";
const TURNSTILE = "0x4GeheimVanTurnstile456";
const NAMEN = {
  deur: "wi-direct",
  inlog: "wi-direct-inlog",
  worker: "wi-direct-worker",
  publiek: "wi-direct-publiek",
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
      orgSlug: "winco",
      slaap: async () => {},
    }),
    maakAdmin: w.maakAdmin,
    gh: w.gh,
    wachtOpDiscovery: async () => {},
    toegang,
    accountId: "acc",
    wachtwoord: () => "GeheimDatabaseWachtwoord1234567",
    maskeer: (waarde) => geheimen.push(waarde),
    geheimen,
    smtpWachtwoord: SMTP,
    ...extra,
  };
}

const app = (w, naam) => w.staat.apps.find((a) => a.name === naam);
const project = (w, naam = "wi-direct") => w.staat.projecten.find((p) => p.name === naam);
const auth = (w, naam) => w.staat.auth[project(w, naam).ref];
const stap = (r, naam) => r.stappen.find((s) => s.stap === naam)?.actie;
const cfSchrijf = (w) => w.schrijfacties().filter((s) => / cf\//.test(s));

/** De Access op de Worker dekt workers.dev en elk preview-adres, met de groep als policy. */
function eisWorkerDicht(w) {
  const worker = app(w, NAMEN.worker);
  assert.ok(worker, "de Access op de Worker staat er");
  assert.deepEqual(
    worker.destinations.map((x) => x.uri),
    ["wi-direct.stagetwo-acc.workers.dev", "*-wi-direct.stagetwo-acc.workers.dev"],
  );
  const groep = w.staat.policies.find((p) => p.name === "wi-kantoor");
  assert.deepEqual(worker.policies, [{ id: groep.id, precedence: 1 }]);
  assert.equal(groep.decision, "allow");
  assert.ok(!w.staat.policies.some((p) => p.decision === "bypass"), "nergens een bypass");
}

// ---------------------------------------------------------------- de deur

test("deur weg: van deur naar klantportaal haalt de inrichting de deur weg, als laatste, en laat de rest staan", async () => {
  const w = nepWolk();
  await richtIn(ARG, opzet(w, DEUR));
  const deurId = app(w, NAMEN.deur).id;
  const inlogVoor = structuredClone(app(w, NAMEN.inlog));
  assert.equal(app(w, NAMEN.deur).domain, "direct.wincoapps.com");

  w.aanroepen.length = 0;
  const r = await richtIn(ARG, opzet(w, PORTAAL));

  assert.equal(app(w, NAMEN.deur), undefined, "de deur op het domein is weg");
  assert.ok(
    !w.staat.apps.some(
      (a) =>
        a.domain?.startsWith("direct.wincoapps.com") ||
        (a.destinations ?? []).some((x) => x.uri.startsWith("direct.wincoapps.com")),
    ),
    "geen enkele Access-app meer op het domein",
  );
  // De inlogdienst voor medewerkers blijft, met dezelfde client en dezelfde groep.
  assert.deepEqual(app(w, NAMEN.inlog), inlogVoor);
  assert.equal(app(w, NAMEN.inlog).type, "saas");
  eisWorkerDicht(w);

  // Volgorde: eerst de inlogmail aan (PATCH auth), dan pas de deur weg; en de deur is de
  // laatste schrijfactie op Cloudflare.
  const acties = w.schrijfacties();
  const patch = acties.findIndex((s) => /^PATCH sb\/projects\/[^/]+\/config\/auth/.test(s));
  const weg = acties.indexOf(`DELETE cf/access/apps/${deurId}`);
  assert.ok(patch !== -1 && weg !== -1, JSON.stringify(acties));
  assert.ok(patch < weg, "de mail staat aan vóór de deur weggaat");
  assert.deepEqual(cfSchrijf(w), [`DELETE cf/access/apps/${deurId}`]);

  assert.match(stap(r, "3.5 Access-app op de hostname"), /weggehaald.*klantportaal.*open/);
  assert.equal(r.cloudflare.deur, null);
  assert.ok(r.waarschuwingen.some((x) => /klantportaal.*RLS.*enige grens/.test(x)));

  // Een tweede run verandert niets op Cloudflare en maakt geen deur.
  w.aanroepen.length = 0;
  const r2 = await richtIn(ARG, opzet(w, PORTAAL));
  assert.deepEqual(cfSchrijf(w), []);
  assert.match(stap(r2, "3.5 Access-app op de hostname"), /^geen deur/);
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
  assert.equal(deur.domain, "direct.wincoapps.com");
  assert.deepEqual(deur.destinations, [{ type: "public", uri: "direct.wincoapps.com" }]);
  const groep = w.staat.policies.find((p) => p.name === "wi-kantoor");
  assert.deepEqual(deur.policies, [{ id: groep.id, precedence: 1 }]);
  assert.deepEqual(deur.allowed_idps, ["idp-otp"]);
  assert.match(stap(r, "3.5 Access-app op de hostname"), /^aangemaakt/);
  assert.equal(r.cloudflare.deur, deur.id);
  // Inloggen per mail gaat uit, in dezelfde aanroep waarin autoconfirm weer aan gaat, en
  // vóór de deur terugkomt.
  assert.equal(auth(w).external_email_enabled, false);
  assert.equal(auth(w).mailer_autoconfirm, true);
  const acties = w.schrijfacties();
  assert.ok(
    acties.findIndex((s) => /^PATCH sb\/.*config\/auth/.test(s)) <
      acties.indexOf("POST cf/access/apps self_hosted"),
  );
  assert.equal(w.staat.ghVariabelen.production.VITE_INLOGDIENST, "cloudflare");
  eisWorkerDicht(w);
  assert.ok(!r.waarschuwingen.some((x) => /klantportaal/.test(x)));
});

test("droogloop: toont in beide richtingen wat er met de deur en de mail zou gebeuren en schrijft niets", async () => {
  const w = nepWolk();
  await richtIn(ARG, opzet(w, DEUR));
  const deurId = app(w, NAMEN.deur).id;

  // Van deur naar klantportaal.
  w.aanroepen.length = 0;
  let r = await richtIn({ ...ARG, droogloop: true }, opzet(w, PORTAAL));
  assert.deepEqual(w.schrijfacties(), []);
  assert.match(
    stap(r, "3.5 Access-app op de hostname"),
    new RegExp(
      `gepland: wi-direct \\(${deurId}\\) weghalen.*open voor iedereen.*workers\\.dev en de previews blijven dicht`,
    ),
  );
  const mail = stap(r, "3.4 auth-config");
  assert.match(mail, /klantportaal: inloggen per mail aan/);
  assert.match(mail, /zes cijfers.*15 minuten/);
  assert.match(mail, /Winco Direct <noreply@wincoapps\.com>/);
  assert.match(mail, /mailer_autoconfirm uit/);
  assert.match(mail, /captcha uit/);
  assert.ok(!mail.includes("e-mail-inlog uit"));
  assert.ok(app(w, NAMEN.deur), "de deur staat er nog");
  assert.deepEqual(r.waarschuwingen, []);

  // En terug: de deur staat gepland.
  await richtIn(ARG, opzet(w, PORTAAL));
  w.aanroepen.length = 0;
  r = await richtIn({ ...ARG, droogloop: true }, opzet(w, DEUR));
  assert.deepEqual(w.schrijfacties(), []);
  assert.equal(
    stap(r, "3.5 Access-app op de hostname"),
    "gepland: wi-direct op direct.wincoapps.com",
  );
  assert.match(stap(r, "3.4 auth-config"), /e-mail-inlog uit$/);

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
  await richtIn(ARG, opzet(w, PORTAAL));
  eisWorkerDicht(w);
  await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, PORTAAL));
  eisWorkerDicht(w);

  // Een tweede groep erbij: de Access op de Worker en de inlogdienst volgen, het domein
  // krijgt geen app terug.
  const meer = {
    groepen: { ...GROEPEN, extern: { adressen: ["hulp@bureau.nl"] } },
    apps: { direct: { ...PORTAAL.apps.direct, groepen: ["kantoor", "extern"] } },
  };
  await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, meer));
  const ids = ["wi-kantoor", "wi-extern"].map((n) => w.staat.policies.find((p) => p.name === n).id);
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
    ["wi-direct.stagetwo-acc.workers.dev", "*-wi-direct.stagetwo-acc.workers.dev"],
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
  await richtIn(ARG, opzet(w, PORTAAL));
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
    apps: [{ id: "x", name: "met de hand", type: "self_hosted", domain: "direct.wincoapps.com" }],
  });
  await assert.rejects(() => richtIn(ARG, opzet(w, PORTAAL)), /bewaakt direct\.wincoapps\.com al/);
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
  await richtIn(ARG, opzet(w, PORTAAL));
  assert.equal(app(w, NAMEN.publiek), undefined);
  assert.equal(app(w, NAMEN.deur), undefined);
  for (const naam of [NAMEN.worker, NAMEN.inlog]) {
    assert.ok(!app(w, naam).policies.some((p) => p.id === bypass.id), `${naam} zonder bypass`);
  }
  // Toegang bijwerken ruimt daarna de ongebruikte bypass-policy op.
  await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, PORTAAL));
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
  "smtp_host",
  "smtp_port",
  "smtp_user",
  "smtp_pass",
  "smtp_admin_email",
  "smtp_sender_name",
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
];

test("mail: productie van een klantportaal krijgt inloggen per mail, Resend, code en link, de rem, en autoconfirm uit", async () => {
  const w = nepWolk();
  await richtIn(ARG, opzet(w, PORTAAL));
  const a = auth(w);
  assert.equal(a.external_email_enabled, true);
  assert.equal(a.mailer_autoconfirm, false, "een adres moet eerst bewezen worden");
  assert.equal(a.mailer_allow_unverified_email_sign_ins, false);
  assert.equal(a.security_manual_linking_enabled, false, "geen inlog loskoppelen");
  assert.equal(a.smtp_host, "smtp.resend.com");
  assert.equal(a.smtp_port, "465");
  assert.equal(a.smtp_user, "resend");
  assert.equal(a.smtp_pass, SMTP);
  assert.equal(a.smtp_admin_email, "noreply@wincoapps.com");
  assert.equal(a.smtp_sender_name, "Winco Direct");
  assert.equal(a.mailer_otp_length, 6);
  assert.equal(a.mailer_otp_exp, 900);
  for (const sjabloon of ["confirmation", "magic_link"]) {
    const tekst = a[`mailer_templates_${sjabloon}_content`];
    assert.match(tekst, /\{\{ \.Token \}\}/, `${sjabloon}: de code`);
    assert.match(tekst, /href="\{\{ \.ConfirmationURL \}\}"/, `${sjabloon}: de link`);
    assert.match(tekst, /15 minuten/);
    assert.equal(a[`mailer_subjects_${sjabloon}`], "Inloggen bij Winco Direct");
  }
  assert.match(a.mailer_templates_recovery_content, /\{\{ \.ConfirmationURL \}\}/);
  assert.ok(!a.mailer_templates_recovery_content.includes(".Token"));
  // De rem.
  assert.equal(a.rate_limit_email_sent, 100);
  assert.equal(a.smtp_max_frequency, 60);
  assert.equal(a.rate_limit_otp, 15);
  assert.equal(a.rate_limit_verify, 15);
  assert.equal(a.security_captcha_enabled, false);
  assert.ok(!("security_captcha_secret" in a));
  // De adressen om naar terug te keren: het domein en de previews van dit account.
  assert.equal(a.site_url, "https://direct.wincoapps.com");
  assert.equal(
    a.uri_allow_list,
    "https://direct.wincoapps.com/**,https://pr-*-wi-direct.stagetwo-acc.workers.dev/**,https://actueel-wi-direct.stagetwo-acc.workers.dev/**",
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
  // Productie toont beide manieren van inloggen; de previews (testdatabase) alleen Cloudflare.
  assert.equal(KLANTPORTAAL_INLOGDIENST, "cloudflare,mailcode");
  assert.equal(w.staat.ghVariabelen.production.VITE_INLOGDIENST, "cloudflare,mailcode");
  assert.equal(w.staat.ghVariabelen.preview.VITE_INLOGDIENST, "cloudflare");
  assert.equal(w.staat.ghVariabelen.repo.PREVIEW_VITE_INLOGDIENST, "cloudflare");
});

test("mail: de getallen van de rem en de geldigheid van de code staan op één plek", () => {
  assert.deepEqual(REM, {
    rate_limit_email_sent: 100,
    smtp_max_frequency: 60,
    rate_limit_otp: 15,
    rate_limit_verify: 15,
  });
  assert.equal(CODE_GELDIG_SECONDEN, 900);
});

test("mail: de naam van de afzender kan geen HTML of sjabloonopdracht worden", () => {
  const m = inlogmail("Jansen & Zn. (Direct)");
  assert.match(m.metCode, /Jansen &amp; Zn\. \(Direct\)/);
  assert.equal(m.onderwerp, "Inloggen bij Jansen & Zn. (Direct)");
  assert.throws(() => inlogmail("x {{ .Token }}"), /ongeldig teken/);
  assert.throws(() => inlogmail("<b>x</b>"), /ongeldig teken/);
  assert.throws(
    () => klantportaalInstellingen({ afzender: { adres: "a@b.nl", naam: "A" } }),
    /SMTP_WACHTWOORD ontbreekt/,
  );
});

test("mail: zonder naam in de afzender is de naam die van de app", async () => {
  const w = nepWolk();
  const t = {
    groepen: GROEPEN,
    apps: {
      direct: { groepen: ["kantoor"], klantportaal: true, afzender: "Noreply@WincoApps.com" },
    },
  };
  await richtIn(ARG, opzet(w, t));
  assert.equal(auth(w).smtp_admin_email, "noreply@wincoapps.com");
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

test("captcha: de schakelaar zet Turnstile aan met het geheim, en stopt vóór wijzigingen als het geheim ontbreekt", async () => {
  const aan = {
    groepen: GROEPEN,
    apps: { direct: { ...PORTAAL.apps.direct, captcha: true } },
  };
  const leeg = nepWolk();
  await assert.rejects(
    () => richtIn(ARG, opzet(leeg, aan)),
    /gestopt zonder wijzigingen.*captcha staat aan.*TURNSTILE_GEHEIM ontbreekt/,
  );
  assert.deepEqual(leeg.schrijfacties(), []);

  const w = nepWolk();
  const d = opzet(w, aan, { captchaGeheim: TURNSTILE });
  const r = await richtIn(ARG, d);
  assert.equal(auth(w).security_captcha_enabled, true);
  assert.equal(auth(w).security_captcha_provider, "turnstile");
  assert.equal(auth(w).security_captcha_secret, TURNSTILE);
  assert.ok(!uitvoerRegel(r, d.geheimen).includes(TURNSTILE));
  assert.ok(!JSON.stringify(r).includes(TURNSTILE));

  // Weer uit: de schakelaar gaat uit; het geheim wordt niet meer meegestuurd.
  w.aanroepen.length = 0;
  await richtIn(ARG, opzet(w, PORTAAL, { captchaGeheim: TURNSTILE }));
  assert.equal(auth(w).security_captcha_enabled, false);
  assert.ok(!w.aanroepen.some((a) => JSON.stringify(a.body ?? "").includes(TURNSTILE)));

  const droog = await richtIn(
    { ...ARG, droogloop: true },
    opzet(w, aan, { captchaGeheim: TURNSTILE }),
  );
  assert.match(stap(droog, "3.4 auth-config"), /captcha aan \(Turnstile\)/);
});

// ---------------------------------------------------------------- de testdatabase

test("de testdatabase van een klantportaal blijft zoals bij elke app: e-mail alleen voor testaccounts, geen SMTP, autoconfirm aan", async () => {
  const w = nepWolk();
  const gewoon = nepWolk();
  const arg = { ...ARG, testdatabase: true };
  await richtIn(arg, opzet(w, PORTAAL));
  await richtIn(arg, opzet(gewoon, DEUR));
  const test = auth(w, "wi-direct-test");
  assert.deepEqual(test, auth(gewoon, "wi-direct-test"), "exact als bij een gewone app");
  assert.equal(test.mailer_autoconfirm, true);
  assert.equal(test.hook_before_user_created_enabled, true);
  assert.ok(!Object.keys(test).some((k) => /^smtp_|rate_limit|captcha|mailer_otp/.test(k)));
  // Het SMTP-wachtwoord gaat alleen naar productie.
  const ref = project(w, "wi-direct-test").ref;
  assert.ok(
    !w.aanroepen.some(
      (a) => (a.pad ?? "").includes(ref) && JSON.stringify(a.body ?? "").includes(SMTP),
    ),
  );
  // De hook van de testdatabase is dezelfde SQL.
  const sql = (x) =>
    x.staat.sqlOp.filter((q) => q.ref === project(x, "wi-direct-test").ref).map((q) => q.query);
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
    email: "anna@winco.nl",
    identities: [cf("anna@winco.nl")],
    app_metadata: { provider: "custom:cloudflare", providers: ["custom:cloudflare"] },
  },
  // Vertrokken: staat in uitsluiten.
  {
    id: ID(6),
    email: "oud@winco.nl",
    identities: [cf("oud@winco.nl")],
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
  const r = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, PORTAAL));
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
  const r = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, PORTAAL));
  assert.deepEqual(bans(w), []);
  assert.deepEqual(afgemeld(w), []);
  assert.deepEqual(r.klanten, { direct: 1500 });
  assert.deepEqual(r.ingetrokken, {});
});

test("geen ban voor klanten: een klant met een adres op het domein van de medewerkers, per mail ingelogd, is en blijft een gewone klant", async () => {
  const w = await portaalMet([
    {
      id: ID(1),
      email: "stagiair@winco.nl",
      identities: [mail("stagiair@winco.nl")],
      app_metadata: { providers: ["email"] },
    },
    // Uitgesloten adres, maar alleen per mail: geen medewerkersaccount, dus geen oordeel.
    {
      id: ID(2),
      email: "oud@winco.nl",
      identities: [mail("oud@winco.nl")],
      app_metadata: { providers: ["email"] },
    },
  ]);
  const r = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, PORTAAL));
  assert.deepEqual(bans(w), []);
  assert.deepEqual(r.klanten, { direct: 2 });
});

test("wel ban voor een vertrokken medewerker: ban én afmelden, ook bij een klantportaal", async () => {
  const w = await portaalMet(MENSEN());
  const r = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, PORTAAL));
  assert.deepEqual(bans(w).sort(), [ID(6), ID(8)]);
  assert.deepEqual(afgemeld(w).sort(), [ID(6), ID(8)]);
  assert.deepEqual(r.ingetrokken, { direct: ["oud@winco.nl", "hulp@bureau.nl"] });
  for (const a of w.aanroepen.filter((x) => x.methode === "updateUserById")) {
    assert.equal(a.body.ban_duration, "876000h");
  }
  // De blijvende medewerker en de al ingetrokken medewerker: geen aanroep.
  assert.ok(!bans(w).includes(ID(5)));
  assert.ok(!bans(w).includes(ID(7)));
  // Een tweede run doet niets meer.
  w.aanroepen.length = 0;
  w.staat.sql.length = 0;
  await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, PORTAAL));
  assert.deepEqual(bans(w), []);
  assert.deepEqual(afgemeld(w), []);
});

test("wel ban voor een vertrokken medewerker: de Cloudflare-inlog komt uit de database, want de gebruikerslijst geeft geen identiteiten mee", async () => {
  // Alleen de identiteit zegt dat dit een medewerker is: geen app_metadata.
  const w = await portaalMet([
    { id: ID(1), email: "oud@winco.nl", identities: [cf("oud@winco.nl")] },
    { id: ID(2), email: "klant@elders.nl", identities: [mail("klant@elders.nl")] },
  ]);
  const r = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, PORTAAL));
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
      email: "oud@winco.nl",
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
  const r = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, PORTAAL));
  assert.deepEqual(bans(w).sort(), [ID(1), ID(2)]);
  assert.deepEqual(r.klanten, { direct: 1 });
});

test("een account met een Cloudflare- én een e-mailinlog: een vertrokken medewerker gaat helemaal dicht, een blijvende blijft", async () => {
  const w = await portaalMet([
    // Was medewerker, logde ook per mail in. Uit de groep: het hele account dicht.
    {
      id: ID(1),
      email: "oud@winco.nl",
      identities: [mail("oud@winco.nl"), cf("oud@winco.nl")],
      app_metadata: { provider: "email", providers: ["email", "custom:cloudflare"] },
    },
    // Is medewerker en logde ook per mail in: blijft.
    {
      id: ID(2),
      email: "anna@winco.nl",
      identities: [mail("anna@winco.nl"), cf("anna@winco.nl")],
      app_metadata: { provider: "email", providers: ["email", "custom:cloudflare"] },
    },
    // Zette zelf een ander adres op zijn account; Cloudflare kent hem als oud@winco.nl.
    {
      id: ID(3),
      email: "prive@gmail.com",
      identities: [cf("Oud@Winco.nl")],
      app_metadata: { providers: ["custom:cloudflare"] },
    },
    // Medewerker met een eigen adres op het account: Cloudflare kent hem als anna@winco.nl.
    {
      id: ID(4),
      email: "anna.prive@gmail.com",
      identities: [cf("anna@winco.nl")],
      app_metadata: { providers: ["custom:cloudflare"] },
    },
  ]);
  const r = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, PORTAAL));
  assert.deepEqual(bans(w).sort(), [ID(1), ID(3)]);
  assert.deepEqual(afgemeld(w).sort(), [ID(1), ID(3)]);
  assert.deepEqual(r.ingetrokken, { direct: ["oud@winco.nl", "prive@gmail.com"] });
  assert.deepEqual(r.klanten, { direct: 0 }, "geen van de vier telt als klant");
});

test("een Cloudflare-account zonder eigen adres wordt beoordeeld op het adres van Cloudflare, en gemeld", async () => {
  const w = await portaalMet([
    // De medewerker maakte eerst per mail een klantaccount; Cloudflare gaf hem daarna een
    // tweede account zonder adres.
    {
      id: ID(1),
      email: "anna@winco.nl",
      identities: [mail("anna@winco.nl")],
      app_metadata: { providers: ["email"] },
    },
    {
      id: ID(2),
      identities: [cf("anna@winco.nl")],
      app_metadata: { providers: ["custom:cloudflare"] },
    },
    // Hetzelfde, maar van iemand die niet meer in de groep staat: dicht.
    {
      id: ID(3),
      identities: [cf("oud@winco.nl")],
      app_metadata: { providers: ["custom:cloudflare"] },
    },
  ]);
  const r = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, PORTAAL));
  assert.deepEqual(bans(w), [ID(3)]);
  assert.deepEqual(afgemeld(w), [ID(3)]);
  assert.deepEqual(r.klanten, { direct: 1 });
  assert.ok(
    r.waarschuwingen.some((x) =>
      /anna@winco\.nl heeft via Cloudflare een account zonder adres/.test(x),
    ),
    JSON.stringify(r.waarschuwingen),
  );
});

test("geeft de database geen lijst terug op de vraag naar de Cloudflare-inlogs, dan stopt Toegang bijwerken zonder iemand te bannen", async () => {
  for (const raar of [{ rows: [] }, "ok", null, [{ email: "x@y.nl" }]]) {
    const w = await portaalMet(MENSEN());
    w.staat.identiteitenAntwoord = raar;
    await assert.rejects(
      () => werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, PORTAAL)),
      /auth\.identities.*er is niets ingetrokken/,
    );
    assert.deepEqual(bans(w), []);
    assert.deepEqual(afgemeld(w), []);
  }
});

test("een medewerker die weer in de groep komt, krijgt bij een klantportaal de ban opgeheven; een geblokkeerde klant niet", async () => {
  const w = await portaalMet(MENSEN());
  const terug = {
    groepen: { kantoor: { domeinen: ["winco.nl"], adressen: ["ex@bureau.nl"] } },
    apps: PORTAAL.apps,
  };
  const r = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, terug));
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
  const droog = await werkToegangBij({ voorvoegsel: "wi-", droogloop: true }, opzet(w, PORTAAL));
  assert.deepEqual(w.schrijfacties(), []);
  assert.ok(
    droog.acties.some((a) => /klantportaal direct: de deur wi-direct staat er nog/.test(a)),
  );
  const r = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, PORTAAL));
  assert.equal(app(w, NAMEN.deur)?.id, deurId, "de deur staat er nog");
  assert.ok(r.acties.some((a) => /draai App inrichten/.test(a)));
  assert.equal(auth(w).external_email_enabled, false, "en mail staat nog uit");
  // De klanten zijn nu al veilig: het bestand zegt klantportaal.
  assert.deepEqual(bans(w).sort(), [ID(6), ID(8)]);
});

test("de testdatabase van een klantportaal: Toegang bijwerken trekt daar in zoals bij elke app, met de testaccounts ongemoeid", async () => {
  const w = nepWolk();
  await richtIn({ ...ARG, testdatabase: true }, opzet(w, PORTAAL));
  const url = (naam) => `https://${project(w, naam).ref}.supabase.co`;
  w.staat.gebruikersOp[url("wi-direct")] = MENSEN();
  w.staat.gebruikersOp[url("wi-direct-test")] = [
    { id: ID(21), email: "anna@winco.nl" },
    { id: ID(22), email: "vreemd@elders.nl" },
    { id: ID(23), email: "testgebruiker@stagetwo.nl" },
  ];
  w.aanroepen.length = 0;
  const r = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, PORTAAL));
  assert.deepEqual(r.ingetrokken, {
    direct: ["oud@winco.nl", "hulp@bureau.nl"],
    "direct (test)": ["vreemd@elders.nl"],
  });
  assert.deepEqual(r.klanten, { direct: 4 });
  // De vraag naar auth.identities gaat alleen naar productie.
  const vragen = w.aanroepen.filter((a) => a.body?.query === CLOUDFLARE_IDENTITEITEN_SQL);
  assert.deepEqual(
    vragen.map((a) => a.pad.includes(project(w, "wi-direct-test").ref)),
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
    { ...ARG, app: "intern", hostname: "intern.wincoapps.com", worker: "wi-intern" },
    opzet(w, twee),
  );
  assert.ok(app(w, "wi-intern"), "de gewone app heeft zijn deur");
  assert.equal(app(w, "wi-direct"), undefined);
  assert.equal(auth(w, "wi-intern").external_email_enabled, false);
  assert.equal(auth(w, "wi-intern").mailer_autoconfirm, true);
  const url = (naam) => `https://${project(w, naam).ref}.supabase.co`;
  w.staat.gebruikersOp[url("wi-direct")] = [{ id: ID(1), email: "klant@elders.nl" }];
  w.staat.gebruikersOp[url("wi-intern")] = [{ id: ID(2), email: "klant@elders.nl" }];
  w.aanroepen.length = 0;
  const r = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, twee));
  assert.deepEqual(r.ingetrokken, { intern: ["klant@elders.nl"] });
  assert.deepEqual(r.klanten, { direct: 1 });
  assert.deepEqual(bans(w), [ID(2)]);
});

test("terug naar de deur (gedocumenteerd gevolg): zodra klantportaal uit toegang.json is, zijn de klanten gewone vreemden en trekt Toegang bijwerken ze in", async () => {
  const w = await portaalMet(MENSEN());
  const r = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, DEUR));
  assert.deepEqual(bans(w).sort(), [ID(1), ID(2), ID(4), ID(6), ID(8)]);
  assert.equal(r.klanten, undefined);
});
