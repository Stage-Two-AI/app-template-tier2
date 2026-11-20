/**
 * Klantportaal met accounts (uitgave 46): `"klantportaal_inloggen": "account"` in toegang.json.
 * Klanten loggen in met e-mail en wachtwoord, een account komt er alleen op uitnodiging van een
 * medewerker, en een klant kan zelf een tweede stap met een authenticator-app aanzetten. Alleen
 * voor apps van de openbare template. De tests leggen vast wat de inrichting dan anders zet dan
 * bij de code per mail, en dat een app zonder klant-uitnodigen niet wordt opengezet.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  APP_ACCOUNTS,
  KLANTACCOUNTS_INLOGDIENST,
  KLANTPORTAAL_INLOGDIENST,
  leesArgumenten,
  metConfig,
  richtIn,
} from "./inrichten-cloudflare.mjs";
import { auth, HOOKS, opzet, PORTAAL, PORTAAL_APP, stap } from "./klantportaal-opzet.mjs";
import {
  klantportaalInstellingen,
  LINK_GELDIG_SECONDEN,
  WACHTWOORD_MINIMAAL,
} from "./lib/supabase.mjs";
import {
  inloggenVanApp,
  MELDING_ALLEEN_UITNODIGING,
  MELDING_GEEN_WACHTWOORD,
  MELDING_MEDEWERKER,
  portaalAanmeldHookSql,
  portaalTokenHookSql,
  UITNODIGING_FUNCTIE,
  valideerToegang,
} from "./lib/toegang.mjs";
import { GEWOON, OPENBAAR } from "./lib/variant.mjs";
import { nepWolk } from "./nep-wolk.mjs";

const HIER = dirname(fileURLToPath(import.meta.url));
const DATA = join(HIER, "testdata", "openbaar");
const WRANGLER = readFileSync(join(DATA, "wrangler.jsonc"), "utf8");
const MAP = mkdtempSync(join(tmpdir(), "beheer-accounts-"));
const MET_DOMEIN = join(MAP, "met-domein.jsonc");
writeFileSync(
  MET_DOMEIN,
  WRANGLER.replace(
    '"preview_urls": true\n',
    '"preview_urls": true,\n  "routes": [{ "pattern": "direct.voorbeeldapps.nl", "custom_domain": true }]\n',
  ),
);

const GEWOON_MET_DOMEIN = join(MAP, "gewoon-met-domein.jsonc");
writeFileSync(
  GEWOON_MET_DOMEIN,
  readFileSync(join(HIER, "..", "wrangler.jsonc"), "utf8").replace(
    '"preview_urls": true\n',
    '"preview_urls": true,\n  "routes": [{ "pattern": "direct.voorbeeldapps.nl", "custom_domain": true }]\n',
  ),
);

const ACCOUNTS = {
  ...PORTAAL,
  apps: { direct: { ...PORTAAL_APP, klantportaal_inloggen: "account" } },
};
const MET_FUNCTIE = {
  "src/lib/env.ts": readFileSync(join(DATA, "env.ts.txt"), "utf8"),
  "stack.config.json": readFileSync(join(DATA, "stack.config.json"), "utf8"),
  [APP_ACCOUNTS.bestand]: "// de Edge Function van de app\n",
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
    inloggen: "account",
    ...extra,
  });

// ---------------------------------------------------------------- toegang.json

test("toegang.json: klantportaal_inloggen is code of account, alleen bij een klantportaal, en accounts nooit zonder captcha", () => {
  assert.equal(inloggenVanApp(valideerToegang(PORTAAL), "direct"), "code");
  assert.equal(inloggenVanApp(valideerToegang(ACCOUNTS), "direct"), "account");
  const met = (velden) => ({ ...PORTAAL, apps: { direct: { ...PORTAAL_APP, ...velden } } });
  assert.throws(() => valideerToegang(met({ klantportaal_inloggen: "wachtwoord" })), /"code"/);
  assert.throws(
    () => valideerToegang(met({ klantportaal_inloggen: "account", captcha: false })),
    /niet zonder captcha/,
  );
  assert.throws(
    () =>
      valideerToegang({
        ...PORTAAL,
        apps: { direct: { groepen: ["kantoor"], klantportaal_inloggen: "account" } },
      }),
    /hoort bij een klantportaal/,
  );
});

// ---------------------------------------------------------------- de hooks

test("aanmeld-hook met accounts: medewerkers nog steeds geweigerd, en een klant alleen met een open uitnodiging", () => {
  const sql = portaalAanmeldHookSql(ACCOUNTS, "direct", HOOKS.aanmelden);
  assert.ok(sql.includes(MELDING_MEDEWERKER));
  assert.ok(sql.includes(`if not coalesce(${UITNODIGING_FUNCTIE}(event), false) then`));
  assert.ok(sql.includes(MELDING_ALLEEN_UITNODIGING));
  // Eerst de medewerker, dan de uitnodiging: een medewerker kan niet als klant worden uitgenodigd.
  assert.ok(sql.indexOf(MELDING_MEDEWERKER) < sql.indexOf(UITNODIGING_FUNCTIE));
  // Cloudflare blijft vóór alles doorgaan: medewerkers maken hun account zelf.
  assert.ok(sql.indexOf("custom:cloudflare") < sql.indexOf(UITNODIGING_FUNCTIE));
  // Bij de code per mail verandert er niets.
  assert.ok(!portaalAanmeldHookSql(PORTAAL, "direct", HOOKS.aanmelden).includes("klantaccount"));
});

test("token-hook met accounts: een wachtwoord is de inlog, dus elk token gaat door; bij de code blijft de weigering", () => {
  const sql = portaalTokenHookSql(HOOKS.token, { wachtwoord: true });
  assert.ok(!sql.includes(MELDING_GEEN_WACHTWOORD));
  assert.match(sql, /return jsonb_build_object\('claims', event->'claims'\);/);
  assert.match(sql, /revoke execute on function public\.vb_portaal_voor_token\(jsonb\) from/);
  assert.ok(portaalTokenHookSql(HOOKS.token).includes(MELDING_GEEN_WACHTWOORD));
});

// ---------------------------------------------------------------- de instellingen van Supabase

test("instellingen met accounts: wachtwoord van 10 tekens, tweede stap aan, links naar /wachtwoord-instellen die pas na een klik omwisselen", () => {
  const i = inst();
  assert.equal(i.password_min_length, WACHTWOORD_MINIMAAL);
  assert.equal(WACHTWOORD_MINIMAAL, 10);
  assert.equal(i.mfa_totp_enroll_enabled, true);
  assert.equal(i.mfa_totp_verify_enabled, true);
  assert.equal(i.mailer_otp_exp, LINK_GELDIG_SECONDEN);
  assert.ok(
    i.mailer_templates_invite_content.includes(
      'href="{{ .SiteURL }}/wachtwoord-instellen?token_hash={{ .TokenHash }}&type=invite"',
    ),
  );
  assert.ok(
    i.mailer_templates_recovery_content.includes(
      'href="{{ .SiteURL }}/wachtwoord-instellen?token_hash={{ .TokenHash }}&type=recovery"',
    ),
  );
  // Geen inlogcode per mail: die mails zeggen dat je met je wachtwoord inlogt.
  for (const soort of ["magic_link", "confirmation"]) {
    assert.doesNotMatch(i[`mailer_templates_${soort}_content`], /Token|TokenHash/);
  }
  // Geen link die bij openen al iets doet, en geen adres dat de aanvrager kiest.
  for (const tekst of Object.values(i).filter((x) => typeof x === "string")) {
    assert.ok(!/ConfirmationURL|RedirectTo/.test(tekst));
  }
  // De rest van het klantportaal blijft: captcha, geen autoconfirm, hooks.
  assert.equal(i.security_captcha_enabled, true);
  assert.equal(i.mailer_autoconfirm, false);
  assert.equal(i.hook_before_user_created_enabled, true);
  assert.throws(() => inst({ captcha: false }), /niet zonder captcha/);
  // De code per mail houdt zijn eigen instellingen.
  const code = inst({ inloggen: "code" });
  assert.equal(code.password_min_length, undefined);
  assert.equal(code.mfa_totp_enroll_enabled, undefined);
});

// ---------------------------------------------------------------- de inrichting

test("inrichten met accounts: VITE_INLOGDIENST cloudflare,wachtwoord, de hooks met uitnodiging en de instellingen, en de waarschuwing voor de regel bij Cloudflare", async () => {
  const w = nepWolk({ ghBestanden: MET_FUNCTIE });
  const r = await richtIn(argumenten(), opzet(w, ACCOUNTS));
  assert.equal(w.staat.ghVariabelen.production.VITE_INLOGDIENST, KLANTACCOUNTS_INLOGDIENST);
  assert.equal(KLANTACCOUNTS_INLOGDIENST, "cloudflare,wachtwoord");
  assert.match(stap(r, "3.4 hooks van het klantportaal"), /alleen op uitnodiging/);
  const a = auth(w);
  assert.equal(a.password_min_length, 10);
  assert.equal(a.mfa_totp_verify_enabled, true);
  assert.equal(a.security_captcha_enabled, true);
  const sql = w.staat.sql.join("\n");
  assert.ok(sql.includes(UITNODIGING_FUNCTIE));
  assert.ok(!sql.includes(MELDING_GEEN_WACHTWOORD), "de token-hook weigert geen wachtwoord");
  assert.ok(r.waarschuwingen.some((x) => /rate-limitregel/.test(x) && /tweede-stap/.test(x)));
  assert.ok(r.waarschuwingen.some((x) => /klant-uitnodigen/.test(x)));
  // Een run met het vinkje vindt daarna niets meer te wijzigen en haalt de deur weg.
  await richtIn({ ...argumenten(), deurWeghalen: true }, opzet(w, ACCOUNTS));
  assert.equal(
    w.staat.apps.some((x) => x.name === "vb-direct"),
    false,
  );
});

test("inrichten met accounts stopt vóór de eerste wijziging bij een app zonder klant-uitnodigen, of van de gewone template", async () => {
  const zonder = { ...MET_FUNCTIE };
  delete zonder[APP_ACCOUNTS.bestand];
  const w = nepWolk({ ghBestanden: zonder });
  await assert.rejects(richtIn(argumenten(), opzet(w, ACCOUNTS)), /versie 46/);
  assert.deepEqual(w.staat.projecten, []);
  const w2 = nepWolk({ ghBestanden: MET_FUNCTIE });
  await assert.rejects(
    richtIn(argumenten(GEWOON), opzet(w2, ACCOUNTS)),
    /alleen in de openbare template/,
  );
  // Bij de code per mail leest de inrichting de functie niet en blijft alles zoals het was.
  const w3 = nepWolk({ ghBestanden: zonder });
  await richtIn(argumenten(), opzet(w3, PORTAAL));
  assert.equal(w3.staat.ghVariabelen.production.VITE_INLOGDIENST, KLANTPORTAAL_INLOGDIENST);
});
