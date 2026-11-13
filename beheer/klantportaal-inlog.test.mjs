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
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CAPTCHA_UIT, richtIn, uitvoerRegel } from "./inrichten-cloudflare.mjs";
import {
  ARG,
  app,
  auth,
  DEUR,
  GROEPEN,
  HOOKS,
  MET_VINKJE,
  NAMEN,
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
  GEEN_CONTROLECODE,
  GOKKEN_PER_DAG,
  klantportaalInstellingen,
  neutraleMails,
  REM,
  veiligHookAdres,
} from "./lib/supabase.mjs";
import {
  MELDING_GEEN_WACHTWOORD,
  portaalAanmeldHookSql,
  portaalTokenHookSql,
  valideerToegang,
} from "./lib/toegang.mjs";
import { nepWolk } from "./nep-wolk.mjs";

const inst = (extra = {}) =>
  klantportaalInstellingen({
    afzender: { adres: "noreply@voorbeeldapps.nl", naam: "Voorbeeld Direct" },
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
    /grant execute on function public\.vb_portaal_voor_token\(jsonb\) to supabase_auth_admin;/,
  );
  assert.match(
    sql,
    /revoke execute on function public\.vb_portaal_voor_token\(jsonb\) from authenticated, anon, public;/,
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

test("eigen hooks van de app: een klantportaal gebruikt de hooks van de inrichting. Heeft de app een eigen aanmeld-, token- of send-email-hook, dan stopt de inrichting vóór de eerste wijziging, ook zichtbaar in de droogloop; er is geen schakelaar om hem te laten staan", async () => {
  const w = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(w, DEUR));
  const eigen = {
    hook_custom_access_token_enabled: true,
    hook_custom_access_token_uri: "pg-functions://postgres/public/app_rollen_in_token",
    hook_before_user_created_enabled: true,
    hook_before_user_created_uri: "pg-functions://postgres/public/app_alleen_uitgenodigd",
  };
  Object.assign(auth(w), eigen);
  const droog = await richtIn({ ...ARG, droogloop: true }, opzet(w, PORTAAL));
  const tekst = droog.waarschuwingen.join(" ");
  assert.match(tekst, /de echte run stopt hierop.*eigen aanmeld-hook.*app_alleen_uitgenodigd/);
  assert.match(tekst, /de echte run stopt hierop.*eigen token-hook.*app_rollen_in_token/);
  assert.match(
    tekst,
    /Een klantportaal gebruikt de hooks van de inrichting; haal de eigen hook weg of overleg met Stage Two/,
  );
  // Ook stap 3 en het vinkje stoppen, zonder iets te wijzigen: de deur blijft.
  for (const arg of [ARG, MET_VINKJE]) {
    w.aanroepen.length = 0;
    await assert.rejects(
      () => richtIn(arg, opzet(w, PORTAAL)),
      /gestopt zonder wijzigingen.*eigen aanmeld-hook.*eigen token-hook/,
    );
    assert.deepEqual(w.schrijfacties(), []);
  }
  for (const [k, waarde] of Object.entries(eigen)) assert.equal(auth(w)[k], waarde, k);
  assert.equal(auth(w).external_email_enabled, false, "productie draait gewoon door");
  assert.ok(app(w, NAMEN.deur));

  // De schakelaar "eigen_hooks" bestaat niet meer: toegang.json weigert het veld.
  const metEigen = { groepen: GROEPEN, apps: { direct: { ...PORTAAL_APP, eigen_hooks: true } } };
  assert.throws(() => valideerToegang(metEigen), /veld eigen_hooks: onbekend veld/);
  await assert.rejects(() => richtIn(ARG, opzet(w, metEigen)), /eigen_hooks: onbekend veld/);
  // Een eigen hook die de mail verstuurt gaat buiten de sjablonen om: ook stoppen, en van het
  // adres staat alleen het schema en de host in de melding.
  const mailhook = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(mailhook, DEUR));
  Object.assign(auth(mailhook), {
    hook_send_email_enabled: true,
    hook_send_email_uri: "https://hooks.voorbeeld.test/mail?sleutel=sk_EchtGeheimInDeUrl",
  });
  const fout = await richtIn(ARG, opzet(mailhook, PORTAAL)).catch((f) => f);
  assert.match(
    fout.message,
    /eigen hook die de mail verstuurt \(send email\): https:\/\/hooks\.voorbeeld\.test \(de rest van het adres is niet getoond\)/,
  );
  assert.doesNotMatch(fout.message, /sk_EchtGeheim/);
});

test("eigen hooks van de app: van een hook over HTTP toont een melding alleen het schema en de host, nooit het pad of een sleutel in het adres", async () => {
  assert.equal(
    veiligHookAdres(
      "https://gebruiker:wachtwoord@Hooks.Voorbeeld.test:8443/claims/sk_pad?sleutel=sk_x#y",
    ),
    "https://hooks.voorbeeld.test (de rest van het adres is niet getoond)",
  );
  assert.equal(
    veiligHookAdres("pg-functions://postgres/public/eigen_hook"),
    "pg-functions://postgres/public/eigen_hook",
  );
  assert.equal(
    veiligHookAdres("pg-functions://postgres/public/x'; drop"),
    "pg-functions://postgres",
  );
  assert.equal(veiligHookAdres("onzin"), "(adres niet te lezen)");
  const w = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(w, DEUR));
  Object.assign(auth(w), {
    hook_custom_access_token_enabled: true,
    hook_custom_access_token_uri:
      "https://hooks.voorbeeld.test/claims?sleutel=sk_EchtGeheimInDeUrl",
  });
  const d = opzet(w, PORTAAL);
  const uit = [];
  uit.push(uitvoerRegel(await richtIn({ ...ARG, droogloop: true }, d), d.geheimen));
  const fout = await richtIn(ARG, d).catch((f) => f);
  uit.push(uitvoerRegel({ status: "mislukt", reden: fout.message }, d.geheimen));
  for (const regel of uit) {
    assert.match(regel, /https:\/\/hooks\.voorbeeld\.test \(de rest/);
    assert.doesNotMatch(regel, /sk_EchtGeheimInDeUrl|claims\?/);
  }
});

test("adres wijzigen: een account is niet naar het adres van een ander te zetten; de mail daarvoor bevat geen link en geen code, en hetzelfde geldt voor elke andere mail buiten de hooks om", () => {
  const i = inst();
  // Supabase Auth verstuurt zes soorten mail met een link of code (templatemailer.go:
  // invite, confirmation, recovery, magic_link, email_change, reauthentication). Laat de
  // inrichting er één ongemoeid, dan geldt het standaardsjabloon, met {{ .ConfirmationURL }}:
  // een link die bij openen (ook door een linkscanner) al bevestigt.
  const soorten = [
    "invite",
    "confirmation",
    "recovery",
    "magic_link",
    "email_change",
    "reauthentication",
  ];
  for (const soort of soorten) {
    const inhoud = i[`mailer_templates_${soort}_content`];
    assert.ok(
      typeof inhoud === "string" && inhoud.length > 20,
      `${soort} heeft een eigen sjabloon`,
    );
    assert.ok(i[`mailer_subjects_${soort}`], `${soort} heeft een eigen onderwerp`);
    assert.doesNotMatch(inhoud, /ConfirmationURL|RedirectTo/, soort);
    assert.doesNotMatch(
      i[`mailer_subjects_${soort}`],
      /\{\{/,
      `${soort}: geen code in het onderwerp`,
    );
  }
  // Adres wijzigen (PUT /user) gaat langs geen van beide hooks, en de mail gaat naar een adres
  // dat de aanvrager zelf kiest. Zonder link, code of token_hash is de wijziging niet te
  // bevestigen: het account blijft op zijn eigen adres.
  for (const soort of ["email_change", "reauthentication"]) {
    assert.doesNotMatch(
      i[`mailer_templates_${soort}_content`],
      /\{\{/,
      `${soort}: geen enkele sjabloonopdracht`,
    );
  }
  assert.match(i.mailer_templates_email_change_content, /Dat kan niet zelf: er is niets gewijzigd/);
  assert.match(i.mailer_templates_email_change_content, /neem dan contact op met Voorbeeld Direct/);
  // De uitnodiging logt niet in: alleen een verwijzing naar de inlogpagina op het eigen domein.
  assert.deepEqual(i.mailer_templates_invite_content.match(/\{\{[^}]*\}\}/g), ["{{ .SiteURL }}"]);
  // Wie de code van acht cijfers wil raden om de wijziging toch te bevestigen, moet er twee raden.
  assert.equal(i.mailer_secure_email_change_enabled, true);
  // De sjablonen zijn gewone tekst: een sjabloon dat Supabase Auth niet kan lezen, vervangt het
  // stil door het standaardsjabloon. Ook met een naam vol leestekens blijft het leesbaar.
  const lastig = neutraleMails("Bloem & Zn. (O'Neill)");
  for (const tekst of Object.values(lastig)) assert.doesNotMatch(tekst, /\{\{(?! \.SiteURL \}\})/);
  assert.match(lastig.mailer_templates_email_change_content, /Bloem &amp; Zn\. \(O&#39;Neill\)/);
  assert.throws(() => neutraleMails("{{ .Token }}"), /ongeldig teken/);
  assert.equal(i.mailer_templates_reauthentication_content, GEEN_CONTROLECODE.inhoud);
});

test("de hooks werken ook als de app het schema public heeft dichtgezet: beide scripts geven Supabase Auth zelf het recht op het schema, zoals de documentatie voorschrijft", () => {
  for (const sql of [
    portaalAanmeldHookSql(PORTAAL, "direct", HOOKS.aanmelden),
    portaalTokenHookSql(HOOKS.token),
  ]) {
    const naam = sql.match(/create or replace function (public\.[a-z_]+)\(event jsonb\)/)[1];
    const rechten = sql.slice(sql.indexOf("$hook$;"));
    // Na `revoke usage on schema public from public` in een migratie van de app kan Supabase
    // Auth de hook anders niet aanroepen, en dan komt niemand meer binnen, ook medewerkers niet.
    assert.match(rechten, /grant usage on schema public to supabase_auth_admin;/);
    assert.ok(rechten.includes(`grant execute on function ${naam}(jsonb) to supabase_auth_admin;`));
    assert.ok(
      rechten.includes(
        `revoke execute on function ${naam}(jsonb) from authenticated, anon, public;`,
      ),
    );
    // Geen recht voor wie dan ook op meer dan dat: de functies lezen geen tabellen.
    assert.equal(rechten.match(/\bgrant\b/g).length, 2);
    assert.match(sql, /set search_path = ''/);
  }
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
    assert.equal(i[`mailer_subjects_${soort}`], "Inloggen bij Voorbeeld Direct");
  }
  assert.match(
    tekst,
    /niet zelf, zojuist, op de inlogpagina van Voorbeeld Direct aangevraagd\? Dan hoef je niets te doen/,
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
  await richtIn(ARG, opzet(w, DEUR));
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
  // aanvaller vraagt steeds een nieuwe code aan. Wat telt is dus hoeveel gokken één IP-adres
  // per dag heeft: de voorraad van 30 één keer, daarna 5 per vijf minuten.
  const dag = teller(REM.rate_limit_verify);
  let perDag = 0;
  for (let s = 0; s < 24 * 3600; s += 1) while (dag(s)) perDag += 1;
  assert.equal(GOKKEN_PER_DAG, 1470);
  assert.ok(Math.abs(perDag - GOKKEN_PER_DAG) <= 1, `${perDag} gokken per dag vanaf één IP-adres`);
  const kans = (adressen, cijfers = CODE_LENGTE) =>
    1 - (1 - 10 ** -cijfers) ** (adressen * GOKKEN_PER_DAG);
  // Honderd adressen: ongeveer 0,15 procent per dag. Met zes cijfers was dat ruim 13 procent.
  assert.ok(kans(100) > 0.0014 && kans(100) < 0.0016, `${(kans(100) * 100).toFixed(3)}%`);
  assert.ok(kans(100, 6) > 0.13);
  // De aanname: de teller telt per letterlijk IP-adres. Eén aansluiting met IPv6 heeft er
  // miljarden; telt Supabase die niet samen, dan is met 65.536 adressen de kans ruim de helft.
  assert.ok(kans(65536) > 0.5);
  // KLANTPORTAAL.md zegt precies dit en belooft niet meer: de som, en de aanname als open punt
  // vóór de eerste klant.
  const uitleg = readFileSync(new URL("./KLANTPORTAAL.md", import.meta.url), "utf8");
  assert.match(uitleg, /1470 gokken per IP-adres per dag/);
  assert.match(uitleg, /0,15 procent/);
  assert.match(
    uitleg,
    /Open punten vóór de eerste klant[\s\S]*IPv6[\s\S]*Vraag\s+dit bij Supabase na/,
  );
  assert.doesNotMatch(uitleg, /een half procent/);
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

// ---------------------------------------------------------------- de hooks en toegang.json

test("geen SQL via toegang.json: een groep, domein, adres of naam met aanhalingstekens, een $-blok, een backslash of een regeleinde wordt geweigerd vóór er één regel SQL bestaat", () => {
  const gif = [
    "x'; drop table auth.users; --@voorbeeld.nl",
    "a@b.nl' or '1'='1",
    "$hook$; select 1; $hook$@x.nl",
    "a\\'@x.nl",
    "a@x.nl\n'; select 1; --",
  ];
  for (const g of gif) {
    for (const groep of [
      { adressen: [g] },
      { domeinen: [g] },
      { domeinen: ["x.nl"], uitsluiten: [g] },
    ]) {
      const t = { groepen: { kantoor: groep }, apps: { direct: { ...PORTAAL_APP } } };
      assert.throws(() => valideerToegang(structuredClone(t)), /ongeldig/, g);
      assert.throws(() => portaalAanmeldHookSql(t, "direct", HOOKS.aanmelden), /ongeldig/, g);
    }
    for (const naam of [g, "kantoor'; --"]) {
      assert.throws(
        () =>
          valideerToegang({
            groepen: { [naam]: { domeinen: ["x.nl"] } },
            apps: { direct: [naam] },
          }),
        /naam alleen kleine letters/,
      );
    }
    const afzender = { ...PORTAAL_APP, afzender: `${g} <noreply@voorbeeld.nl>` };
    assert.throws(
      () => valideerToegang({ groepen: GROEPEN, apps: { direct: afzender } }),
      /afzender/,
    );
  }
  assert.throws(() => portaalAanmeldHookSql(PORTAAL, "direct", "x; drop"), /ongeldige functienaam/);
  assert.throws(() => portaalTokenHookSql("X"), /ongeldige functienaam/);
});

test("de aanmeld-hook laat geen adres op het domein van een medewerker door: hoofdletters, spaties, een tab of twee apenstaartjes helpen niet", () => {
  // Tegen een echte Postgres gedraaid (13-11-2026) met "a@b"@voorbeeld.nl, Nieuw@VOORBEELD.NL,
  // " nieuw@voorbeeld.nl", "nieuw@voorbeeld.nl\t", nieuw@elders.nl@voorbeeld.nl en nieuw+klant@voorbeeld.nl:
  // allemaal geweigerd. Hier staat vast waar dat op rust.
  const sql = portaalAanmeldHookSql(PORTAAL, "direct", HOOKS.aanmelden);
  // Het adres wordt eerst klein gemaakt, en het domein is wat na het eerste apenstaartje komt.
  assert.match(sql, /adres text := lower\(coalesce\(event->'user'->>'email', ''\)\);/);
  assert.match(sql, /domein text := split_part\(adres, '@', 2\);/);
  // Een adres met witruimte of meer dan één apenstaartje is geen adres: geweigerd, vóór de
  // vergelijking met de groepen.
  const vorm = sql.indexOf("adres !~ '^[^@[:space:]]+@[^@[:space:]]+$'");
  const groepen = sql.indexOf("domein = any (array['voorbeeld.nl']::text[])");
  assert.ok(vorm !== -1 && groepen !== -1 && vorm < groepen);
  // Alles wat niet per mail of via Cloudflare komt (ook anoniem) wordt geweigerd.
  assert.match(sql, /if aanbieder <> 'email' or adres !~/);
});

test("afzender: hetzelfde patroon als Supabase voor smtp_admin_email hanteert; wat toegang.json doorlaat, weigert Supabase niet om zijn vorm", () => {
  // Het patroon uit UpdateAuthConfigBody van de Management API (13-11-2026).
  const supabase =
    /^(?:[A-Za-z0-9_'+-]+\.)*[A-Za-z0-9_'+-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/;
  const adressen = [
    "noreply@klant.nl",
    "no.reply+portaal@mail.klant.nl",
    "o'neil@klant.nl",
    "a@b.nl",
    // Wat het oude patroon doorliet en Supabase weigert:
    "naam.@klant.nl",
    ".naam@klant.nl",
    "na%am@klant.nl",
    "naam..x@klant.nl",
    "naam@-klant.nl",
    "naam@klant",
    "naam@klant.n1",
  ];
  for (const adres of adressen) {
    const toegang = { groepen: GROEPEN, apps: { direct: { ...PORTAAL_APP, afzender: adres } } };
    let door = true;
    try {
      valideerToegang(toegang);
    } catch {
      door = false;
    }
    assert.equal(door, supabase.test(adres), adres);
  }
  assert.equal(adressen.filter((a) => supabase.test(a)).length, 4);
});

test("een klantportaal zet anoniem aanmelden en de zeven meldingsmails van Supabase Auth uitdrukkelijk uit", () => {
  const i = klantportaalInstellingen({
    afzender: { adres: "noreply@klant.nl", naam: "Voorbeeld" },
    smtpWachtwoord: "x",
    captchaGeheim: "y",
    hooks: HOOKS,
  });
  assert.equal(i.external_anonymous_users_enabled, false);
  const meldingen = Object.keys(i).filter((k) => /^mailer_notifications_.*_enabled$/.test(k));
  assert.deepEqual(meldingen.sort(), [
    "mailer_notifications_email_changed_enabled",
    "mailer_notifications_identity_linked_enabled",
    "mailer_notifications_identity_unlinked_enabled",
    "mailer_notifications_mfa_factor_enrolled_enabled",
    "mailer_notifications_mfa_factor_unenrolled_enabled",
    "mailer_notifications_password_changed_enabled",
    "mailer_notifications_phone_changed_enabled",
  ]);
  for (const k of meldingen) assert.equal(i[k], false, k);
});
