/**
 * De Supabase-kant van de inrichting: het project (Management API) en de custom
 * OIDC-provider `custom:cloudflare` (via supabase-js admin, met de service role).
 *
 * Wat hier bewust niet gebeurt:
 *   - `disable_signup` aanraken. Die moet uit blijven, anders krijgt zelfs een
 *     toegelaten gebruiker bij zijn eerste login geen account. De poort is de
 *     Access-policy op de SaaS-app (KTD5).
 *   - Edge Functions of hun instellingen aanraken.
 *
 * Veldnamen met `NAGAAN (U7)` komen uit één bron of zijn nog niet tegen de echte API
 * getest.
 */
import { createClient } from "@supabase/supabase-js";
import { vraag, wacht } from "./vraag.mjs";

export const SUPABASE_API = "https://api.supabase.com/v1";
export const REGIO = "eu-central-1";
export const PROVIDER = "custom:cloudflare";

export function supabaseUrl(ref) {
  return `https://${ref}.supabase.co`;
}

/** Het adres waar de inlogdienst naar terugstuurt: de enige redirect van de SaaS-app. */
export function callbackAdres(ref) {
  return `${supabaseUrl(ref)}/auth/v1/callback`;
}

/**
 * De adressen waar Supabase na het inloggen naar terug mag. Het account-subdomein komt
 * uit de API en is nooit een wildcard: `https://pr-*-app.*.workers.dev` zou elke Worker
 * van elk account toelaten, en daarmee een token naar een vreemde site sturen.
 *
 * `hostname` is het eigen domein, of in de tijdelijke stand van wrangler.jsonc het
 * workers.dev-adres van de Worker (`<worker>.<subdomein>.workers.dev`). Daarnaast de
 * previews: per PR (`pr-<nummer>-<worker>`) en het vaste adres (`actueel-<worker>`).
 */
export function uriAllowList({ hostname, worker, subdomein }) {
  if (!subdomein || !/^[a-z0-9-]+$/i.test(subdomein)) {
    throw new Error(
      `het workers.dev-subdomein "${subdomein}" is ongeldig; een wildcard mag daar nooit staan`,
    );
  }
  if (!/^[a-z0-9-]+$/.test(worker ?? "")) throw new Error(`de Worker-naam "${worker}" is ongeldig`);
  return [
    `https://${hostname}/**`,
    `https://pr-*-${worker}.${subdomein}.workers.dev/**`,
    // Het vaste preview-adres (label `actueel`, zie Preview uitrollen).
    `https://actueel-${worker}.${subdomein}.workers.dev/**`,
  ];
}

/**
 * De auth-instellingen voor productie. NAGAAN (U7): `uri_allow_list` is in de
 * Management API één tekst met komma's, geen lijst.
 */
export function authInstellingen({ hostname, worker, subdomein }) {
  return {
    site_url: `https://${hostname}`,
    uri_allow_list: uriAllowList({ hostname, worker, subdomein }).join(","),
    external_email_enabled: false,
    // Cloudflare Access geeft een adres pas door na controle (mailcode of de IdP van de
    // klant), maar zet geen email_verified in het id_token. Zonder autoconfirm weigert
    // Supabase dan de inlog ("Unverified email with custom:cloudflare") en koppelt het de
    // inlog niet aan een bestaande gebruiker met hetzelfde adres. email_verified via
    // attribute_mapping kan niet ("protected system field"). Veilig, omdat inloggen met
    // mail en wachtwoord hierboven uit staat. Gevonden bij de doorsteek, 29-09-2026.
    // In de testdatabase staat e-mail wel aan, maar alleen samen met een aanmeld-hook die
    // naar de provider kijkt (aanmeldHookSql in toegang.mjs).
    mailer_autoconfirm: true,
  };
}

/** Mail van een klantportaal gaat via Resend, over SMTP (standaardkeuze 8 van uitgave 43). */
export const SMTP_HOST = "smtp.resend.com";
/** Poort 465: versleuteld vanaf de eerste byte. De gebruikersnaam is bij Resend altijd `resend`. */
export const SMTP_POORT = "465";
export const SMTP_GEBRUIKER = "resend";

/**
 * De inlogcode: acht cijfers, een kwartier geldig. Acht in plaats van zes omdat een fout
 * antwoord de code niet ongeldig maakt en Supabase Auth geen teller per account heeft: met
 * zes cijfers en een paar honderd IP-adressen was een account in een dag te raden (zie REM).
 * De inlogpagina van de app moet dezelfde lengte verwachten.
 */
export const CODE_LENGTE = 8;
export const CODE_GELDIG_SECONDEN = 15 * 60;

/**
 * Supabase Auth geeft elke teller per IP-adres een voorraad van 30 verzoeken die meteen op
 * mogen (de "burst", vast in de broncode), en vult die daarna aan met de ingestelde waarde
 * per vijf minuten.
 */
export const BURST = 30;

/**
 * De rem op een open inlogformulier. De eenheden komen uit de broncode van Supabase Auth
 * (internal/api/apilimiter/apilimiter.go en internal/api/api.go, commit 8872586 van
 * 11-11-2026):
 *
 *   rate_limit_email_sent  mails per uur, voor het hele project samen, vast venster. 100:
 *                          ruim voor een drukke ochtend (een klant logt zelden opnieuw in),
 *                          en een mailbom kost hoogstens 2400 mails per dag. Is de grens
 *                          bereikt, dan krijgt dat uur niemand meer een mail.
 *   smtp_max_frequency     seconden tussen twee mails naar hetzelfde adres. 60.
 *   rate_limit_otp         aanvullen per vijf minuten per IP-adres, voor ZES tellers die elk
 *                          hun eigen voorraad van 30 hebben: /signup, /otp, /magiclink,
 *                          /recover, /resend en het wijzigen van een account. De eerste drie
 *                          sturen een mail naar elk adres dat de aanvrager noemt. Eén
 *                          IP-adres kan dus zonder captcha in een paar seconden 90 mails naar
 *                          verzonnen adressen laten sturen, en haalt de grens van 100 binnen
 *                          een paar minuten, welk getal hier ook staat (de voorraad van 30
 *                          is niet in te stellen). 5: de laagste waarde waarmee een mens die
 *                          zich vertypt nog verder kan (één nieuwe poging per minuut na de
 *                          eerste 30).
 *   rate_limit_verify      aanvullen per vijf minuten per IP-adres voor het inwisselen van
 *                          een code of link, ook met een voorraad van 30. 5: in het kwartier
 *                          dat een code geldt zijn dat 30 + 3 x 5 = 45 gokken per IP-adres,
 *                          op honderd miljoen mogelijkheden (acht cijfers). Over een hele
 *                          dag is het 30 + 288 x 5 = 1470 gokken per IP-adres (GOKKEN_PER_DAG).
 *                          Met honderd IP-adressen is de kans op één goede gok dan ongeveer
 *                          0,15 procent per dag; met zes cijfers was dat ruim 13 procent.
 *                          Aanname: de teller telt per letterlijk adres. Eén aansluiting
 *                          met IPv6 heeft er miljarden; telt het platform van Supabase die
 *                          niet samen, dan is deze grens voor zo'n aanvaller veel zwakker.
 *                          Vraag dat bij Supabase na vóór een klant live gaat (README).
 *
 * De tellers per IP-adres houden dus één mens tegen, geen aanvaller die de mailgrens wil
 * opmaken. Daarvoor is de captcha, die bij een klantportaal standaard aan staat: Supabase Auth
 * controleert hem op /signup, /otp, /magiclink, /recover, /resend en /token (wachtwoord), en
 * stuurt zonder geldig bewijs geen mail. Met `"captcha": false` vervalt die bescherming; het
 * resultaat van de inrichting zegt dat dan elke run.
 */
export const REM = {
  rate_limit_email_sent: 100,
  smtp_max_frequency: 60,
  rate_limit_otp: 5,
  rate_limit_verify: 5,
};

/**
 * De sessieduur van een klantportaal: een sessie die 30 dagen niet is gebruikt, vervalt
 * (`sessions_inactivity_timeout`, in uren; hetzelfde als de 30 dagen van de deur bij een
 * gewone app). Alleen inactiviteit, geen vaste einddatum (`sessions_timebox`): die zou elke
 * klant op een vaste dag uitloggen, ook midden in het werk. Zonder grens bleef de sessie van
 * een vertrokken medewerker op een groep met een domein voorgoed geldig. De 12 uur voor
 * medewerkerrechten dwingt de app af, niet Supabase: die kent maar één duur voor iedereen.
 *
 * Supabase biedt dit alleen op het Pro-plan en hoger. Daarom gaat het in een eigen aanroep,
 * na de rest: weigert Supabase hem, dan is de rest al gezet en meldt de inrichting het.
 */
/** Hoeveel codes één IP-adres in een dag kan proberen: de voorraad, plus de aanvulling. */
export const GOKKEN_PER_DAG = BURST + ((24 * 60) / 5) * REM.rate_limit_verify;

export const SESSIE = { sessions_inactivity_timeout: 30 * 24 };

function htmlTekst(tekst) {
  return String(tekst)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * De link in de mail gaat naar de inlogpagina van de app (`/login`) met `token_hash`, niet
 * naar Supabase zelf. De pagina logt pas in na een klik op een knop: een virusscanner of een
 * mailprogramma dat links vooraf opent, verbruikt de link dan niet en logt niemand in.
 * `{{ .SiteURL }}` is het eigen domein (site_url); een aanvrager kan het adres dus niet
 * sturen, anders dan bij `{{ .RedirectTo }}`. Dezelfde vorm als het lokale sjabloon van de
 * app (supabase/templates/inlogcode.html): de code in `id="code"`, de link in `id="link"`.
 */
export const INLOGLINK = "{{ .SiteURL }}/login?token_hash={{ .TokenHash }}&type=email";

/**
 * De mail van een klantportaal: één sjabloon voor alle drie de soorten die Supabase Auth
 * verstuurt, in dezelfde vorm als het lokale sjabloon van de app. `{{ .Token }}`,
 * `{{ .TokenHash }}` en `{{ .SiteURL }}` vult Supabase Auth in. De naam komt uit
 * toegang.json en mag geen HTML of sjabloonopdracht kunnen worden: het patroon van de
 * afzender laat dat niet toe, en hier wordt hij nog eens als tekst gezet.
 *
 *   magic_link    een bekend adres vraagt een code;
 *   confirmation  een adres zonder account: de eerste keer van een nieuwe klant, de eerste
 *                 inlog van een nieuwe medewerker via Cloudflare, en ook als een ander dit
 *                 adres opgeeft;
 *   recovery      iemand roept /recover aan. De code daaruit werkt in hetzelfde codevak.
 *
 * Omdat een ander de mail kan uitlokken, zegt de tekst wat je doet als je er niet om vroeg:
 * niets, niet klikken, de code aan niemand geven. Dat een vooraf door een ander gezet
 * wachtwoord na jouw bevestiging geen sessie oplevert, regelt de token-hook, niet deze tekst.
 */
export function inlogmail(naam) {
  if (/[{}<>]/.test(naam)) throw new Error("de naam van de afzender bevat een ongeldig teken");
  const n = htmlTekst(naam);
  const minuten = CODE_GELDIG_SECONDEN / 60;
  return {
    onderwerp: `Inloggen bij ${naam}`,
    inhoud: [
      `<h2>Inloggen bij ${n}</h2>`,
      "<p>Vul deze code in op de inlogpagina:</p>",
      '<p style="font-size: 28px; font-weight: bold; letter-spacing: 6px"><span id="code">{{ .Token }}</span></p>',
      `<p>De code is ${minuten} minuten geldig en werkt één keer.</p>`,
      `<p>Of <a id="link" href="${INLOGLINK}">log in met deze link</a>.</p>`,
      `<p>Heb je dit niet zelf, zojuist, op de inlogpagina van ${n} aangevraagd? Dan hoef je niets te doen. Klik niet op de link en geef de code aan niemand; zonder de code kan niemand inloggen.</p>`,
    ].join("\n"),
  };
}

/**
 * De mails die bij een klantportaal NIET bruikbaar mogen zijn. Supabase Auth verstuurt ze
 * buiten de twee hooks om, en de standaardsjablonen bevatten een link die bij openen al
 * bevestigt (`{{ .ConfirmationURL }}`) of een code:
 *
 *   email_change      een ingelogde gebruiker vraagt een ander adres aan (PUT /user). De mail
 *                     gaat naar een adres dat hij zelf kiest. Met het standaardsjabloon zou een
 *                     klant zijn account op het adres van een ander kunnen zetten zodra die
 *                     ander (of de linkscanner van zijn mailserver) de link opent. Hier staat
 *                     geen link en geen code in: een adreswijziging is zo niet te bevestigen.
 *                     Adres wijzigen loopt bij een klantportaal via de eigenaar van de app.
 *   reauthentication  de controlecode voor het wijzigen van een wachtwoord. Wachtwoorden
 *                     bestaan hier niet; de mail zegt dat en bevat geen code.
 *   invite            een uitnodiging uit het dashboard van Supabase. Geen link die inlogt;
 *                     de mail verwijst naar de inlogpagina, waar de genodigde een code aanvraagt.
 *
 * In deze teksten staat geen enkele sjabloonopdracht behalve `{{ .SiteURL }}`: een sjabloon dat
 * niet te lezen is, vervangt Supabase Auth stil door het standaardsjabloon (met de link).
 * De tekst van `reauthentication` is voor elk klantportaal dezelfde; daaraan herkent de
 * inrichting later een project dat klantportaal is (geweest), zie wasKlantportaal.
 */
export const GEEN_CONTROLECODE = {
  onderwerp: "Een controlecode is hier niet nodig",
  inhoud:
    "<p>Er is om een controlecode gevraagd. Die is hier niet nodig: je logt in met een inlogcode per mail, zonder wachtwoord.</p>\n<p>Heb je dit niet zelf gedaan? Dan hoef je niets te doen.</p>",
};

export function neutraleMails(naam) {
  if (/[{}<>]/.test(naam)) throw new Error("de naam van de afzender bevat een ongeldig teken");
  const n = htmlTekst(naam);
  return {
    mailer_subjects_email_change: `Je adres bij ${naam} wijzigen`,
    mailer_templates_email_change_content: `<p>Er is gevraagd om het e-mailadres van een account bij ${n} te wijzigen. Dat kan niet zelf: er is niets gewijzigd.</p>\n<p>Wil je een ander adres gebruiken, neem dan contact op met ${n}. Heb je dit niet zelf gevraagd? Dan hoef je niets te doen.</p>`,
    mailer_subjects_reauthentication: GEEN_CONTROLECODE.onderwerp,
    mailer_templates_reauthentication_content: GEEN_CONTROLECODE.inhoud,
    mailer_subjects_invite: `Je kunt inloggen bij ${naam}`,
    mailer_templates_invite_content: `<p>Je bent toegevoegd bij ${n}.</p>\n<p>Ga naar {{ .SiteURL }}/login, vul dit e-mailadres in en vraag een inlogcode aan.</p>`,
  };
}

/**
 * Is dit project klantportaal (geweest)? Te zien aan iets wat alleen de inrichting van een
 * klantportaal zet: een van de twee hooks, of de mail zonder controlecode. Een gewone app die
 * dat nooit was heeft geen van beide, ook niet als iemand met de hand inloggen per mail aanzette.
 */
export function wasKlantportaal(auth, functies) {
  const hooks = [auth?.hook_custom_access_token_uri, auth?.hook_before_user_created_uri];
  return (
    auth?.mailer_templates_reauthentication_content === GEEN_CONTROLECODE.inhoud ||
    hooks.some(
      (uri) =>
        typeof uri === "string" &&
        (uri.endsWith(`/${functies.token}`) || uri.endsWith(`/${functies.aanmelden}`)),
    )
  );
}

/**
 * Een hook-adres voor in een melding: alleen het schema en de host, want in het pad of de
 * query van een HTTP-hook kan een sleutel staan. Van een functie in Postgres ook de naam; dat
 * is een naam, geen geheim.
 */
export function veiligHookAdres(uri) {
  const m = String(uri ?? "").match(/^([a-z][a-z0-9+.-]*):\/\/([^/?#@]*@)?([^/?#:]+)/i);
  if (!m) return "(adres niet te lezen)";
  const [, schema, , host] = m;
  if (schema.toLowerCase() === "pg-functions") {
    const functie = String(uri).match(/^pg-functions:\/\/[^/]+\/([a-z0-9_]+\/[a-z0-9_]+)$/i);
    return functie ? `pg-functions://${host}/${functie[1]}` : `pg-functions://${host}`;
  }
  return `${schema.toLowerCase()}://${host.toLowerCase()} (de rest van het adres is niet getoond)`;
}

/**
 * Welke hooks staan er vóór de run in het project die niet van het klantportaal zijn? Geeft
 * `{ aanmelden?, token?, mail? }` met per hook het veilige adres.
 */
export function andereHooks(auth, functies) {
  const uit = {};
  const ander = (aan, uri, eigen) =>
    aan === true && typeof uri === "string" && uri && !uri.endsWith(`/${eigen}`);
  if (
    ander(
      auth?.hook_before_user_created_enabled,
      auth?.hook_before_user_created_uri,
      functies.aanmelden,
    )
  )
    uit.aanmelden = veiligHookAdres(auth.hook_before_user_created_uri);
  if (
    ander(
      auth?.hook_custom_access_token_enabled,
      auth?.hook_custom_access_token_uri,
      functies.token,
    )
  )
    uit.token = veiligHookAdres(auth.hook_custom_access_token_uri);
  if (auth?.hook_send_email_enabled === true) uit.mail = veiligHookAdres(auth.hook_send_email_uri);
  return uit;
}

/**
 * De twee hooks van een klantportaal in productie (zie portaalAanmeldHookSql en
 * portaalTokenHookSql in toegang.mjs). Schrijf de functies altijd eerst: een hook die naar een
 * functie wijst die niet bestaat, laat elke inlog mislukken.
 */
export function portaalHookInstellingen(functies, eigen = {}) {
  for (const f of [functies?.aanmelden, functies?.token]) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(f ?? "")) throw new Error("de hookfuncties ontbreken");
  }
  // `eigen`: de app heeft daar een eigen hook die de weigering overneemt ("eigen_hooks": true
  // in toegang.json); die blijft dan staan.
  return {
    ...(eigen.aanmelden
      ? {}
      : {
          hook_before_user_created_enabled: true,
          hook_before_user_created_uri: `pg-functions://postgres/public/${functies.aanmelden}`,
        }),
    ...(eigen.token
      ? {}
      : {
          hook_custom_access_token_enabled: true,
          hook_custom_access_token_uri: `pg-functions://postgres/public/${functies.token}`,
        }),
  };
}

/**
 * De auth-instellingen van een klantportaal, alleen voor productie; ze komen bovenop
 * authInstellingen. Veldnamen nagelopen tegen de Management API (UpdateAuthConfigBody in
 * https://api.supabase.com/api/v1-json, 13-11-2026) en tegen de CLI van Supabase
 * (pkg/config/auth.go), die dezelfde velden zet.
 *
 * `mailer_autoconfirm` gaat hier UIT. Bij een gewone app staat hij aan omdat Cloudflare geen
 * email_verified meestuurt (zie authInstellingen), en dat is daar veilig omdat inloggen met
 * e-mail uit staat. Hier staat e-mail aan. Met autoconfirm aan zou iedereen via /signup met
 * een zelfgekozen wachtwoord een account op andermans adres kunnen maken en meteen een
 * sessie krijgen, zonder ooit de mailbox te zien. Met autoconfirm uit moet elk adres eerst
 * bewezen worden met de link of de code uit de mail.
 *
 * Dat alleen is niet genoeg: wie het adres van een klant aanmeldt met een eigen wachtwoord,
 * hoeft alleen te wachten tot de klant de mail gebruikt die daarvan komt. Daarom twee hooks
 * (`hooks`, verplicht): geen sessie met een wachtwoord, en geen aanmelding per mail op een
 * adres van een medewerker.
 *
 * De prijs voor medewerkers, nagespeeld tegen Supabase Auth (13-11-2026):
 *   - een medewerker die al een account had (van vóór het klantportaal) merkt niets;
 *   - een nieuwe medewerker krijgt bij zijn eerste inlog via Cloudflare één keer de melding
 *     dat zijn adres nog bevestigd moet worden, met de inlogmail; daarna werkt het.
 *
 * `mailer_allow_unverified_email_sign_ins` blijft uit: dat is de andere schakelaar waarmee
 * een onbevestigd adres toch kan inloggen. `disable_signup` blijft onaangeroerd.
 *
 * De captcha staat standaard aan (`captcha` is alleen uit met een uitdrukkelijke false). Met
 * CAPTCHA_LATER blijven de captcha-instellingen zoals ze zijn: op een portaal dat al live is
 * verandert alleen een run met het vinkje "Deur weghalen" iets aan de captcha, anders sluit een
 * nieuwe sleutel klanten buiten tot de app ermee is uitgerold. Het geheim moet er dan wel al zijn.
 *
 * `eigenHooks` (`{ aanmelden?, token? }`): die hook is van de app zelf en blijft staan.
 *
 * Adres wijzigen, de controlecode en de uitnodiging krijgen een mail zonder link en zonder
 * code (neutraleMails), en `mailer_secure_email_change_enabled` staat aan: mocht iemand een
 * code van acht cijfers willen raden om een adreswijziging toch te bevestigen, dan moet hij er
 * twee raden (die voor het oude en die voor het nieuwe adres).
 * `smtpWachtwoord` en `captchaGeheim` zijn geheimen. Ze staan alleen in de body van de PATCH
 * en nooit in een melding of in het resultaat.
 */
/** De captcha-instellingen blijven in deze run zoals ze zijn (zie klantportaalInstellingen). */
export const CAPTCHA_LATER = "later";

export function klantportaalInstellingen({
  afzender,
  smtpWachtwoord,
  captcha = true,
  captchaGeheim,
  hooks,
  eigenHooks = {},
}) {
  if (!afzender?.adres || !afzender?.naam)
    throw new Error("de afzender van de inlogmail ontbreekt");
  if (!smtpWachtwoord) throw new Error("SMTP_WACHTWOORD ontbreekt");
  if (captcha !== false && !captchaGeheim) throw new Error("TURNSTILE_GEHEIM ontbreekt");
  const mail = inlogmail(afzender.naam);
  return {
    external_email_enabled: true,
    mailer_autoconfirm: false,
    mailer_allow_unverified_email_sign_ins: false,
    // Zelf een inlog aan een account hangen of ervan afhalen blijft uit. Anders kan een
    // medewerker zijn Cloudflare-inlog loskoppelen, als "klant" verder gaan met dezelfde
    // sessie, en bij zijn vertrek aan Toegang bijwerken ontsnappen.
    security_manual_linking_enabled: false,
    ...portaalHookInstellingen(hooks, eigenHooks),
    smtp_host: SMTP_HOST,
    smtp_port: SMTP_POORT,
    smtp_user: SMTP_GEBRUIKER,
    smtp_pass: smtpWachtwoord,
    smtp_admin_email: afzender.adres,
    smtp_sender_name: afzender.naam,
    mailer_otp_length: CODE_LENGTE,
    mailer_otp_exp: CODE_GELDIG_SECONDEN,
    // Een nieuw adres krijgt het sjabloon "confirmation", een bekend adres "magic_link"
    // (internal/api/magic_link.go), /recover het sjabloon "recovery". Alle drie dezelfde mail.
    mailer_subjects_confirmation: mail.onderwerp,
    mailer_templates_confirmation_content: mail.inhoud,
    mailer_subjects_magic_link: mail.onderwerp,
    mailer_templates_magic_link_content: mail.inhoud,
    mailer_subjects_recovery: mail.onderwerp,
    mailer_templates_recovery_content: mail.inhoud,
    // Alles wat Supabase Auth verder kan mailen: zonder link en zonder code.
    ...neutraleMails(afzender.naam),
    mailer_secure_email_change_enabled: true,
    ...REM,
    ...(captcha === CAPTCHA_LATER
      ? {}
      : captcha !== false
        ? {
            security_captcha_enabled: true,
            security_captcha_provider: "turnstile",
            security_captcha_secret: captchaGeheim,
          }
        : { security_captcha_enabled: false }),
  };
}

/**
 * De before-user-created-hook van de testdatabase. Zet ook inloggen met e-mail aan;
 * schrijf de hookfunctie dus altijd eerst. NAGAAN (U7): de veldnamen
 * `hook_before_user_created_enabled` en `hook_before_user_created_uri` en de vorm
 * `pg-functions://postgres/<schema>/<functie>`.
 */
export function hookInstellingen(functie) {
  return {
    external_email_enabled: true,
    hook_before_user_created_enabled: true,
    hook_before_user_created_uri: `pg-functions://postgres/public/${functie}`,
  };
}

/** Welke velden van `gewenst` in `huidig` anders zijn; leeg = niets te doen. */
export function verschil(huidig, gewenst) {
  const uit = {};
  for (const [k, v] of Object.entries(gewenst)) {
    if (huidig?.[k] !== v) uit[k] = v;
  }
  return uit;
}

/**
 * SUPABASE_ORG_SLUG mag meerdere organisaties noemen, met komma's: `winco,plantas`. Een
 * klant met meer dan één BV houdt zo per BV een eigen organisatie (en rekening), en de
 * beheer-repo vindt de projecten in elk ervan. Een nieuw project komt altijd in de eerste.
 */
export function organisaties(orgSlug) {
  return (orgSlug ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

/** De velden van de auth-config waar een geheim in staat. */
const GEHEIME_VELDEN = ["smtp_pass", "security_captcha_secret"];

export const TURNSTILE_SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Klopt het geheim van de Turnstile-widget? Eén aanroep naar siteverify met een verzonnen
 * bewijs: een onbekend geheim geeft `invalid-input-secret`, een goed geheim klaagt alleen over
 * het bewijs. Geeft null als het klopt, anders de reden. Het geheim staat alleen in de body.
 */
export async function toetsTurnstileGeheim(fetchFn, geheim) {
  let data;
  try {
    const antwoord = await fetchFn(TURNSTILE_SITEVERIFY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: geheim, response: "toets-van-de-inrichting" }),
    });
    data = JSON.parse(await antwoord.text());
  } catch {
    return "Turnstile was niet te bereiken, dus het geheim is niet getoetst. Probeer het later opnieuw";
  }
  const codes = Array.isArray(data?.["error-codes"]) ? data["error-codes"] : [];
  if (codes.includes("invalid-input-secret") || codes.includes("missing-input-secret"))
    return "Turnstile kent dit geheim niet. Kopieer de Secret Key van de widget opnieuw (Cloudflare, Turnstile, de widget, Settings) en zet hem als secret TURNSTILE_GEHEIM";
  return null;
}

export function supabaseBeheer({ fetchFn = fetch, token, orgSlug, slaap = wacht }) {
  if (!token) throw new Error("SUPABASE_ACCESS_TOKEN ontbreekt");
  const s = (pad, opties) => vraag(fetchFn, `${SUPABASE_API}${pad}`, { token, ...opties });
  const orgs = organisaties(orgSlug);
  return {
    async projecten() {
      const lijst = (await s("/projects")) ?? [];
      return lijst.filter(
        (p) => p.status !== "REMOVED" && (!orgs.length || orgs.includes(p.organization_slug)),
      );
    },
    maakProject(naam, wachtwoord) {
      if (!orgs.length) throw new Error("SUPABASE_ORG_SLUG ontbreekt");
      return s("/projects", {
        methode: "POST",
        body: { name: naam, organization_slug: orgs[0], db_pass: wachtwoord, region: REGIO },
      });
    },
    /** Wacht tot het project gezond is; een nieuw project heeft daar een paar minuten voor nodig. */
    async wachtTotGezond(ref, { pogingen = 40, wachtMs = 15000 } = {}) {
      for (let i = 0; i < pogingen; i += 1) {
        const p = await s(`/projects/${ref}`);
        if (p.status === "ACTIVE_HEALTHY") return p;
        if (["INIT_FAILED", "REMOVED", "RESTORE_FAILED"].includes(p.status)) {
          throw new Error(`Supabase-project ${ref} kwam niet goed op (status ${p.status})`);
        }
        await slaap(wachtMs);
      }
      throw new Error(
        `Supabase-project ${ref} is na tien minuten nog niet gezond; kijk in het Supabase-dashboard`,
      );
    },
    /**
     * De anon key (publiek, voor de browser), de service role (alleen hier, nooit in de
     * app) en, als het project die heeft, de publishable key (sb_publishable_...). Die
     * laatste is ook publiek, maar ziet er niet uit als een JWT; guard:secrets laat
     * hem daarom in git staan (stack.config.json), de anon-JWT niet.
     */
    async sleutels(ref) {
      const lijst = (await s(`/projects/${ref}/api-keys?reveal=true`)) ?? [];
      const anon =
        lijst.find((k) => k.name === "anon") ?? lijst.find((k) => k.type === "publishable");
      const service =
        lijst.find((k) => k.name === "service_role") ?? lijst.find((k) => k.type === "secret");
      if (!anon?.api_key || !service?.api_key) {
        throw new Error(`de sleutels van Supabase-project ${ref} zijn niet volledig op te halen`);
      }
      const publishable = lijst.find((k) => k.type === "publishable")?.api_key ?? null;
      return { anon: anon.api_key, serviceRole: service.api_key, publishable };
    },
    /**
     * Het adres van de session pooler (IPv4). De directe databasehost is alleen via IPv6
     * bereikbaar, en de runners van GitHub hebben geen IPv6; deploy-db.yml migreert dus
     * via deze host. NAGAAN (U7): veldnaam db_host en database_type PRIMARY.
     */
    async poolerHost(ref) {
      const lijst = (await s(`/projects/${ref}/config/database/pooler`)) ?? [];
      const primair = lijst.find((p) => p.database_type === "PRIMARY") ?? lijst[0];
      return typeof primair?.db_host === "string" && primair.db_host ? primair.db_host : null;
    },
    /** Een nieuw databasewachtwoord; het oude werkt daarna niet meer. */
    zetDatabaseWachtwoord: (ref, wachtwoord) =>
      s(`/projects/${ref}/database/password`, { methode: "PATCH", body: { password: wachtwoord } }),
    authConfig: (ref) => s(`/projects/${ref}/config/auth`),
    /**
     * Zit er een geheim in de wijziging (het SMTP-wachtwoord, het geheim van de captcha), dan
     * komt de foutmelding van Supabase niet in de fout: die kan een stuk van de waarde
     * terugkaatsen, en een afgekapt geheim herkent geen maskering. Alleen de status en de
     * namen van de velden die Supabase noemt.
     */
    async werkAuthBij(ref, velden) {
      const pad = `/projects/${ref}/config/auth`;
      try {
        return await s(pad, { methode: "PATCH", body: velden });
      } catch (fout) {
        if (!GEHEIME_VELDEN.some((v) => Object.hasOwn(velden, v))) throw fout;
        const genoemd = Object.keys(velden).filter((v) => String(fout.message).includes(v));
        const veilig = new Error(
          `PATCH /v1${pad} gaf ${fout.status ?? "een fout"}. De melding van Supabase is niet getoond, omdat er een geheim in kan staan${genoemd.length ? `; ze noemt: ${genoemd.join(", ")}` : ""}. Kijk in het dashboard van Supabase (Authentication) of de instellingen kloppen`,
        );
        veilig.status = fout.status;
        throw veilig;
      }
    },
    voerSqlUit: (ref, query) =>
      s(`/projects/${ref}/database/query`, { methode: "POST", body: { query } }),
    verwijderProject: (ref) => s(`/projects/${ref}`, { methode: "DELETE" }),
  };
}

/** Standaard: een supabase-js admin-client met de service role, zonder sessie. */
export function standaardAdmin(url, serviceRole) {
  return createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).auth.admin;
}

function eisGeenFout(resultaat, actie) {
  if (resultaat?.error)
    throw new Error(`Supabase ${actie}: ${resultaat.error.message ?? resultaat.error}`);
  return resultaat?.data;
}

/**
 * Zet de custom provider `custom:cloudflare` zoals hij hoort, idempotent via de lijst.
 * Het client_secret van de SaaS-app is alleen bij het aanmaken te zien; ontbreekt het
 * en bestaat de provider nog niet, dan kan dit niet en zegt het script wat te doen.
 * NAGAAN (U7): of `identifier` het voorvoegsel `custom:` zelf moet bevatten.
 */
export async function zetProvider(providers, { issuer, clientId, clientSecret }) {
  const lijst = eisGeenFout(await providers.listProviders(), "listProviders")?.providers ?? [];
  const bestaand = lijst.find((p) => p.identifier === PROVIDER);
  if (!bestaand) {
    if (!clientSecret) {
      throw new Error(
        "de SaaS-app bestaat al maar de provider in Supabase niet, en het client_secret is alleen bij het aanmaken te zien. Ruim op met --opruimen en draai de inrichting opnieuw.",
      );
    }
    eisGeenFout(
      await providers.createProvider({
        provider_type: "oidc",
        identifier: PROVIDER,
        name: "Cloudflare Access",
        client_id: clientId,
        client_secret: clientSecret,
        issuer,
        pkce_enabled: true,
        scopes: ["openid", "email", "profile"],
        enabled: true,
      }),
      "createProvider",
    );
    return "aangemaakt";
  }
  const zelfde =
    bestaand.issuer === issuer &&
    bestaand.client_id === clientId &&
    bestaand.pkce_enabled !== false;
  if (zelfde && !clientSecret) return "ongewijzigd";
  eisGeenFout(
    await providers.updateProvider(PROVIDER, {
      issuer,
      client_id: clientId,
      pkce_enabled: true,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    }),
    "updateProvider",
  );
  return "bijgewerkt";
}

export async function verwijderProvider(providers) {
  const lijst = eisGeenFout(await providers.listProviders(), "listProviders")?.providers ?? [];
  if (!lijst.some((p) => p.identifier === PROVIDER)) return false;
  eisGeenFout(await providers.deleteProvider(PROVIDER), "deleteProvider");
  return true;
}

/** Alle gebruikers van een project, pagina voor pagina. */
export async function alleGebruikers(admin, { perPagina = 1000 } = {}) {
  const alles = [];
  for (let pagina = 1; ; pagina += 1) {
    const data = eisGeenFout(
      await admin.listUsers({ page: pagina, perPage: perPagina }),
      "listUsers",
    );
    const users = data?.users ?? [];
    alles.push(...users);
    if (users.length < perPagina) return alles;
  }
}

/**
 * Alle sessies van een gebruiker beëindigen. De admin-API van supabase-js kan alleen
 * afmelden met het token van de gebruiker zelf; daarom gaat dit via SQL op
 * `auth.sessions`, waarna de refresh-tokens van die sessies niet meer werken.
 * NAGAAN (U7): dat het verwijderen van de sessie de refresh-tokens meeneemt.
 */
export function afmeldSql(userId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    throw new Error(`"${userId}" is geen geldige gebruikers-id`);
  }
  return `delete from auth.sessions where user_id = '${userId}'::uuid;`;
}
