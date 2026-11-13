/**
 * Klantportaal, de inlog: niemand krijgt een sessie op het adres van een ander, en het open
 * inlogformulier is niet goedkoop te misbruiken. Dat speelt zich af in Supabase Auth zelf; de
 * tests hier leggen vast welke instellingen en hooks de inrichting zet, en rekenen de
 * limieten na met het gedrag uit de broncode van Supabase Auth (commit 8872586 van
 * 11-11-2026: internal/api/apilimiter/apilimiter.go, internal/api/api.go,
 * internal/tokens/service.go, internal/hooks). De SQL van de hooks is daarnaast tegen een
 * echte Postgres gedraaid met de invoer die Supabase Auth stuurt.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPTCHA_UIT, richtIn } from "./inrichten-cloudflare.mjs";
import {
  ARG,
  auth,
  DEUR,
  GROEPEN,
  HOOKS,
  naarPortaal,
  opzet,
  PORTAAL,
  PORTAAL_APP,
  project,
} from "./klantportaal-opzet.mjs";
import {
  BURST,
  CODE_GELDIG_SECONDEN,
  CODE_LENGTE,
  klantportaalInstellingen,
  REM,
} from "./lib/supabase.mjs";
import { MELDING_GEEN_WACHTWOORD, portaalTokenHookSql } from "./lib/toegang.mjs";
import { nepWolk } from "./nep-wolk.mjs";

const inst = (extra = {}) =>
  klantportaalInstellingen({
    afzender: { adres: "noreply@wincoapps.com", naam: "Winco Direct" },
    smtpWachtwoord: "x",
    captchaGeheim: "y",
    hooks: HOOKS,
    ...extra,
  });

// ---------------------------------------------------------------- een sessie op andermans adres

test("overname met een wachtwoord: een sessie met een wachtwoord bestaat niet; de token-hook weigert hem, ook bij verversen", async () => {
  // De aanval: /signup met het adres van een klant en een eigen wachtwoord; de klant klikt op
  // de bevestigingsmail; de aanvaller logt in met zijn wachtwoord. Tegen een echte Supabase
  // Auth gaf die laatste stap een sessie. Nu weigert de hook elk token van zo'n sessie.
  const i = inst();
  assert.equal(i.hook_custom_access_token_enabled, true);
  assert.equal(i.hook_custom_access_token_uri, `pg-functions://postgres/public/${HOOKS.token}`);
  // Zonder de hooks zijn de instellingen niet te maken: niemand zet het portaal open zonder.
  assert.throws(() => inst({ hooks: undefined }), /hookfuncties ontbreken/);
  assert.throws(() => inst({ hooks: { aanmelden: HOOKS.aanmelden } }), /hookfuncties ontbreken/);

  const sql = portaalTokenHookSql(HOOKS.token);
  // De inlog van nu met een wachtwoord, en een sessie die ooit met een wachtwoord begon.
  assert.match(sql, /event->>'authentication_method', ''\) = 'password'/);
  assert.match(sql, /jsonb_array_elements\(amr\)[\s\S]*a->>'method' = 'password'/);
  assert.ok(sql.includes(MELDING_GEEN_WACHTWOORD));
  assert.match(sql, /'http_code', 403/);
  // Elk ander token gaat ongewijzigd door: de claims (ook amr) blijven wat de RLS verwacht.
  assert.match(sql, /return jsonb_build_object\('claims', event->'claims'\);/);
  assert.match(
    sql,
    /grant execute on function public\.wi_portaal_voor_token\(jsonb\) to supabase_auth_admin;/,
  );
  assert.match(
    sql,
    /revoke execute on function public\.wi_portaal_voor_token\(jsonb\) from authenticated, anon, public;/,
  );
  assert.throws(() => portaalTokenHookSql("x; drop table y"), /ongeldige functienaam/);

  // In de inrichting: de functie staat in de productiedatabase vóór de auth-config de hook
  // aanzet, en inloggen per mail gaat in dezelfde aanroep aan als de hook.
  const w = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(w, DEUR));
  w.aanroepen.length = 0;
  await richtIn(ARG, opzet(w, PORTAAL));
  const ref = project(w).ref;
  const sqlIndex = w.aanroepen.findIndex(
    (a) => a.pad?.endsWith(`/${ref}/database/query`) && a.body.query === sql,
  );
  const patch = w.aanroepen.filter((a) => a.methode === "PATCH" && a.body?.external_email_enabled);
  assert.equal(patch.length, 1);
  assert.equal(patch[0].body.hook_custom_access_token_enabled, true);
  assert.equal(patch[0].body.hook_before_user_created_enabled, true);
  assert.ok(sqlIndex !== -1 && sqlIndex < w.aanroepen.indexOf(patch[0]));
  assert.equal(auth(w).hook_custom_access_token_enabled, true);
});

test("overname met een wachtwoord: een eigen token-hook van de app wordt vervangen, en het resultaat zegt dat", async () => {
  const w = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(w, DEUR));
  Object.assign(auth(w), {
    hook_custom_access_token_enabled: true,
    hook_custom_access_token_uri: "pg-functions://postgres/public/eigen_hook",
  });
  const r = await richtIn(ARG, opzet(w, PORTAAL));
  assert.equal(
    auth(w).hook_custom_access_token_uri,
    `pg-functions://postgres/public/${HOOKS.token}`,
  );
  assert.ok(
    r.waarschuwingen.some((x) =>
      /eigen token-hook \(pg-functions:\/\/postgres\/public\/eigen_hook\).*vervangen/.test(x),
    ),
    JSON.stringify(r.waarschuwingen),
  );
  const r2 = await richtIn(ARG, opzet(w, PORTAAL));
  assert.ok(!r2.waarschuwingen.some((x) => /eigen token-hook/.test(x)));
});

test("overname met een wachtwoord: de mail die een ander kan uitlokken zegt wat je doet als je er niet om vroeg, en logt nooit in bij openen", () => {
  const i = inst();
  // Eén mail voor de drie soorten (nieuw adres, bekend adres, herstel), zoals het lokale
  // sjabloon van de app. De bescherming tegen een vooraf gezet wachtwoord is de token-hook
  // (de test hierboven), niet de tekst; de tekst helpt de ontvanger.
  const tekst = i.mailer_templates_confirmation_content;
  assert.equal(i.mailer_templates_magic_link_content, tekst);
  assert.equal(i.mailer_templates_recovery_content, tekst);
  for (const soort of ["confirmation", "magic_link", "recovery"]) {
    assert.equal(i[`mailer_subjects_${soort}`], "Inloggen bij Winco Direct");
  }
  assert.match(
    tekst,
    /niet zelf, zojuist, op de inlogpagina van Winco Direct aangevraagd\? Dan hoef je niets te doen/,
  );
  assert.match(tekst, /Klik niet op de link en geef de code aan niemand/);
  // Geen link die bij openen meteen inlogt (ook niet door een virusscanner), en geen adres
  // dat de aanvrager kan sturen (een preview bijvoorbeeld).
  assert.ok(!/ConfirmationURL|RedirectTo/.test(tekst));
  assert.ok(tekst.includes('href="{{ .SiteURL }}/login?token_hash={{ .TokenHash }}&type=email"'));
  // Samen met: geen sessie met een wachtwoord, en geen sessie zonder bevestigd adres.
  assert.equal(i.hook_custom_access_token_enabled, true);
  assert.equal(i.mailer_autoconfirm, false);
});

test("geen sessie zonder de mailbox: autoconfirm en inloggen met een onbevestigd adres staan uit", () => {
  const i = inst();
  assert.equal(i.mailer_autoconfirm, false);
  assert.equal(i.mailer_allow_unverified_email_sign_ins, false);
});

test("geen koppeling aan andermans account: zelf koppelen staat uit en autoconfirm ook", () => {
  const i = inst();
  assert.equal(i.security_manual_linking_enabled, false);
  assert.equal(i.mailer_autoconfirm, false);
});

// ---------------------------------------------------------------- misbruik van het formulier

/** Zoals tollbooth in apilimiter.go: een voorraad van BURST, aangevuld met `perVijfMin`/300 per seconde. */
function teller(perVijfMin, burst = BURST) {
  let tokens = burst;
  let t = 0;
  return (nu) => {
    tokens = Math.min(burst, tokens + ((nu - t) * perVijfMin) / 300);
    t = nu;
    if (tokens >= 1) {
      tokens -= 1;
      return true;
    }
    return false;
  };
}

test("mailgrens opmaken: de captcha staat standaard aan, want de tellers per IP-adres houden één aanvaller niet tegen", async () => {
  // Waarom de captcha de standaard is. /signup, /otp en /magiclink hebben elk een eigen
  // teller per IP-adres met een voorraad van 30; elk verzoek noemt een ander (verzonnen)
  // adres, dus smtp_max_frequency telt niet. Zonder captcha is de grens van het hele project
  // vanaf één IP-adres binnen tien minuten bereikt, welk getal rate_limit_otp ook heeft.
  const routes = [
    teller(REM.rate_limit_otp),
    teller(REM.rate_limit_otp),
    teller(REM.rate_limit_otp),
  ];
  let mails = 0;
  let seconde = 0;
  for (; seconde < 3600 && mails < REM.rate_limit_email_sent; seconde += 1) {
    for (const route of routes) if (route(seconde) && mails < REM.rate_limit_email_sent) mails += 1;
  }
  assert.equal(mails, REM.rate_limit_email_sent);
  assert.ok(seconde <= 600, `zonder captcha na ${seconde} seconden`);
  // De uitleg bij de getallen zegt dat ook, en belooft niet meer dan de getallen waarmaken.
  assert.match(CAPTCHA_UIT, /mailgrens van het hele uur opmaken/);

  // Daarom: de captcha staat aan zonder dat iemand erom vraagt, en Supabase Auth controleert
  // hem op elke route die een mail verstuurt.
  const i = inst();
  assert.equal(i.security_captcha_enabled, true);
  assert.equal(i.security_captcha_provider, "turnstile");
  assert.equal(i.security_captcha_secret, "y");
  assert.throws(() => inst({ captchaGeheim: undefined }), /TURNSTILE_GEHEIM ontbreekt/);
  // Alleen een uitdrukkelijke false zet hem uit; undefined, null of 0 niet.
  for (const raar of [undefined, null, 0, "", "false"]) {
    assert.equal(inst({ captcha: raar }).security_captcha_enabled, true, JSON.stringify(raar));
  }
  assert.equal(inst({ captcha: false, captchaGeheim: undefined }).security_captcha_enabled, false);

  // In de inrichting: een klantportaal zonder keuze heeft de captcha aan; wie hem uitzet,
  // krijgt bij elke run de waarschuwing.
  const w = nepWolk({ workerBestaat: true });
  const aan = await naarPortaal(w);
  assert.equal(auth(w).security_captcha_enabled, true);
  assert.ok(!aan.waarschuwingen.some((x) => x.includes(CAPTCHA_UIT)));
  const uit = { groepen: GROEPEN, apps: { direct: { ...PORTAAL_APP, captcha: false } } };
  for (let run = 0; run < 2; run += 1) {
    const r = await richtIn(ARG, opzet(w, uit));
    assert.ok(r.waarschuwingen.some((x) => x.includes(CAPTCHA_UIT)));
  }
});

test("code raden: acht cijfers, en het aantal gokken per IP-adres klopt met wat de uitleg zegt (de voorraad van 30 telt mee)", () => {
  assert.equal(CODE_LENGTE, 8);
  assert.equal(inst().mailer_otp_length, 8);
  const verify = teller(REM.rate_limit_verify);
  let gokken = 0;
  for (let s = 0; s < CODE_GELDIG_SECONDEN; s += 1) while (verify(s)) gokken += 1;
  // 30 uit de voorraad plus 3 x 5 bijgevuld in het kwartier dat een code geldt.
  const verwacht = BURST + (CODE_GELDIG_SECONDEN / 300) * REM.rate_limit_verify;
  assert.equal(verwacht, 45);
  assert.ok(
    Math.abs(gokken - verwacht) <= 1,
    `${gokken} gokken in een kwartier vanaf één IP-adres`,
  );
  // Een fout antwoord maakt de code niet ongeldig en er is geen teller per account; de
  // aanvaller vraagt elk kwartier een nieuwe code aan. Per dag zijn dat 96 kwartieren.
  const ruimte = 10 ** CODE_LENGTE;
  const kansPerDag = (ips, mogelijkheden = ruimte) =>
    1 - (1 - (ips * gokken) / mogelijkheden) ** 96;
  assert.ok(
    kansPerDag(100) < 0.01,
    `100 IP-adressen: ${(kansPerDag(100) * 100).toFixed(2)}% per dag`,
  );
  assert.ok(
    kansPerDag(1000) < 0.05,
    `1000 IP-adressen: ${(kansPerDag(1000) * 100).toFixed(1)}% per dag`,
  );
  // Met zes cijfers was dat met dezelfde honderd adressen ruim een derde.
  assert.ok(kansPerDag(100, 10 ** 6) > 0.3);
});

test("de rem: elke grens ligt binnen wat de Management API aanneemt en heeft de eenheid uit de broncode", () => {
  // rate_limit_email_sent: per uur, heel project. smtp_max_frequency: seconden per adres.
  // rate_limit_otp en rate_limit_verify: bijvullen per vijf minuten per IP-adres.
  assert.deepEqual(Object.keys(REM).sort(), [
    "rate_limit_email_sent",
    "rate_limit_otp",
    "rate_limit_verify",
    "smtp_max_frequency",
  ]);
  for (const [naam, waarde] of Object.entries(REM)) {
    assert.ok(Number.isInteger(waarde) && waarde >= 1 && waarde <= 32767, naam);
  }
  assert.ok(REM.smtp_max_frequency >= 60, "hoogstens één mail per minuut naar hetzelfde adres");
  assert.ok(
    REM.rate_limit_email_sent * 24 <= 2400,
    "een mailbom kost hoogstens 2400 mails per dag",
  );
  assert.ok(
    CODE_LENGTE >= 6 && CODE_LENGTE <= 10,
    "Supabase Auth neemt 6 tot en met 10 cijfers aan",
  );
});
