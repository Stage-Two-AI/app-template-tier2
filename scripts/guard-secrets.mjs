import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fail, pass } from "./lib/changed-files.mjs";

/**
 * Twee vragen tegelijk:
 *   1. Staat er een geheime sleutel in de repo?
 *   2. Staat er een geheime sleutel in de gebouwde bundel, dus in het bestand dat
 *      iedere bezoeker downloadt?
 *
 * De tweede is de gevaarlijkste van de hele stack. Eén `VITE_`-variabele te veel
 * en de service role key van je klant staat op straat, terwijl de app er van
 * buiten volstrekt normaal uitziet.
 *
 * Een regel in git bewust vrijgeven kan met de markering `guard-secrets:allow` op die regel.
 * In de gebouwde bundel werkt die markering niet: daar is alles vaak één lange regel.
 *
 * Tekst in UTF-16 (een export uit Windows of Excel) lezen we als UTF-16, anders staat er
 * tussen elke letter een nulbyte en past geen enkel patroon. Bestanden die geen tekst zijn
 * (pdf, zip, lettertype, afbeelding, video, wasm) lezen we als losse bytes en zoeken we alleen
 * naar de vorm van een sleutel: een sleutel in public/brochure.pdf staat na de build in dist/
 * en gaat naar elke bezoeker. Wat de guard niet ziet: een sleutel die ingepakt is (een
 * gecomprimeerde stroom in een pdf of zip).
 */
const JWT = /\beyJ[\w-]{10,}\.(eyJ[\w-]{10,})\.[\w-]{5,}/g;

/**
 * De anon key is óók een JWT en hoort wél in de bundel: hij is expres publiek en
 * wordt door RLS beschermd. Elke andere rol, en met name service_role, is een
 * datalek. Daarom kijken we naar de inhoud van het token in plaats van naar de vorm.
 */
function jwtRole(match) {
  try {
    const payload = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
    return typeof payload.role === "string" ? payload.role : "onbekend";
  } catch {
    return "onleesbaar";
  }
}

const PATTERNS = [
  { name: "Supabase secret key", re: /\bsb_secret_[A-Za-z0-9_-]{10,}/ },
  {
    name: "privésleutel",
    re: /-{5}BEGIN (?:[A-Z]+ )?PRIVATE KEY-{5}/,
    // In de bundel is de kale header niet genoeg: cryptobibliotheken (zoals de
    // sleutel-parser in @vercel/blob) bevatten die tekst in hun eigen code. Een
    // gelekte sleutel herken je aan wat erna komt: de base64-inhoud, eventueel
    // met letterlijke "\n"-tekens omdat de bundel geminificeerd is.
    reBundel: /-{5}BEGIN (?:[A-Z]+ )?PRIVATE KEY-{5}(?:\\r?\\?n|\s)*[A-Za-z0-9+/]{40}/,
  },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Stripe live key", re: /\b[rs]k_live_[A-Za-z0-9]{10,}/ },
  { name: "GitHub token", re: /\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { name: "OpenAI/Anthropic-achtige key", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}/ },
  { name: "service role key met waarde", re: /SERVICE_ROLE_KEY\s*[:=]\s*["']?\S{10,}/ },
  // Een Cloudflare-API-sleutel heeft geen herkenbaar voorvoegsel; hij valt op aan de
  // naam waaronder hij wordt toegekend. Een verwijzing als ${{ secrets.X }} is prima.
  {
    name: "Cloudflare-API-sleutel met waarde",
    re: /CLOUDFLARE_[A-Z_]*TOKEN\s*[:=]\s*["']?[A-Za-z0-9_-]{30,}/,
  },
  // Resend: re_, acht tekens, een liggend streepje en de rest. Een naam als re_render past niet.
  { name: "Resend-sleutel", re: /\bre_[A-Za-z0-9]{6,}_[A-Za-z0-9]{16,}/ },
  // Een databaseadres met een wachtwoord erin. Niet: een plek die later wordt ingevuld
  // (`<ww>`, `${ww}`, `$WW`) en de lokale database op deze computer (127.0.0.1, localhost).
  { name: "Postgres-adres met wachtwoord", vind: postgresMetWachtwoord },
];

const POSTGRES = /\bpostgres(?:ql)?:\/\/([^\s:@/'"`]*):([^\s@/'"`]+)@([^\s:/'"`?]+)/gi;

function postgresMetWachtwoord(tekst) {
  for (const [, , wachtwoord = "", host = ""] of tekst.matchAll(POSTGRES)) {
    if (/^(?:127\.0\.0\.1|localhost|\[::1\])$/i.test(host)) continue;
    if (/[<>$]|\{|^\*+$|^\.+$/.test(wachtwoord)) continue;
    return true;
  }
  return false;
}

/** Past dit patroon ergens in de tekst? `bundel`: de strengere vorm voor gebouwde bestanden. */
function past(pattern, tekst, bundel) {
  if (pattern.vind) return pattern.vind(tekst);
  return (bundel && pattern.reBundel ? pattern.reBundel : pattern.re).test(tekst);
}

const SKIP_FILES = new Set(["pnpm-lock.yaml", "scripts/guard-secrets.mjs"]);
/** Geen tekst: deze lezen we als losse bytes (zie `scanBytes`). */
const BINAIR =
  /\.(png|jpe?g|gif|ico|webp|avif|bmp|tiff?|woff2?|ttf|otf|eot|pdf|zip|gz|br|tar|7z|rar|mp[34]|m4a|webm|ogg|wav|mov|wasm)$/i;
const ENV_FILE = /^\.env(\..+)?$/;

const problems = [];

/**
 * De inhoud van een tekstbestand als tekst: UTF-16 (met of zonder BOM, herkend aan de
 * nulbytes om en om) als UTF-16, de rest als UTF-8.
 */
function leesTekst(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return wissel(bytes.subarray(2));
  }
  const begin = bytes.subarray(0, 4096);
  let even = 0;
  let oneven = 0;
  for (let i = 0; i < begin.length; i++) {
    if (begin[i] !== 0) continue;
    if (i % 2 === 0) even++;
    else oneven++;
  }
  const helft = begin.length / 2;
  if (helft >= 4 && oneven >= helft * 0.4 && even < helft * 0.05) {
    return bytes.toString("utf16le");
  }
  if (helft >= 4 && even >= helft * 0.4 && oneven < helft * 0.05) return wissel(bytes);
  return bytes.toString("utf8");
}

/** UTF-16 met de grote byte voorop (big-endian) als tekst. */
function wissel(bytes) {
  const kopie = Buffer.from(bytes.subarray(0, bytes.length - (bytes.length % 2)));
  return kopie.swap16().toString("utf16le");
}

/**
 * Een bestand dat geen tekst is: de bytes één op één als tekens (latin1), en ook als UTF-16
 * (vanaf de eerste en de tweede byte), zodat een sleutel die er als gewone tekst in staat te
 * vinden is. Elk token telt, ook in de bundel (in een afbeelding of pdf hoort zelfs de anon key
 * niet), en de strengste patronen gelden, tegen vals alarm.
 */
function scanBytes(file, bytes, origin) {
  const gevonden = new Set();
  for (const tekst of [
    bytes.toString("latin1"),
    bytes.toString("utf16le"),
    bytes.subarray(1).toString("utf16le"),
  ]) {
    for (const token of tekst.matchAll(JWT))
      gevonden.add(`JSON Web Token met rol "${jwtRole(token)}"`);
    for (const pattern of PATTERNS) {
      if (past(pattern, tekst, true)) gevonden.add(pattern.name);
    }
  }
  for (const wat of gevonden) {
    problems.push(`${origin} ${file}: ${wat} (in een bestand dat geen tekst is)`);
  }
}

function scan(file, content, origin) {
  const isBundle = origin === "[bundel]";
  const lines = content.split("\n");
  for (const [index, line] of lines.entries()) {
    // De markering geldt alleen in git, waar iemand hem in de diff ziet. In een gebouwd
    // bestand (vaak één lange regel) zou hij alles op die regel vrijgeven.
    if (!isBundle && line.includes("guard-secrets:allow")) continue;

    // Elk token op de regel, niet alleen het eerste: in een gebouwd bestand staat de anon key
    // (die mag) soms op dezelfde regel vóór een sleutel die niet mag.
    for (const token of line.matchAll(JWT)) {
      const role = jwtRole(token);
      // In de bundel is alleen de anon key acceptabel; in git hoort geen enkel token.
      if (!isBundle || role !== "anon") {
        problems.push(`${origin} ${file}:${index + 1}: JSON Web Token met rol "${role}"`);
      }
    }

    for (const pattern of PATTERNS) {
      if (past(pattern, line, isBundle)) {
        problems.push(`${origin} ${file}:${index + 1}: ${pattern.name}`);
      }
    }
  }
}

// 1. Alles wat in git zit.
const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);

for (const file of tracked) {
  const base = file.split("/").at(-1) ?? file;
  if (ENV_FILE.test(base) && base !== ".env.example") {
    problems.push(`[git] ${file}: een .env-bestand hoort nooit in git`);
    continue;
  }
  if (SKIP_FILES.has(file)) continue;
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch {
    continue; // weg (nog niet gecommit verwijderd) of onleesbaar
  }
  if (BINAIR.test(file)) scanBytes(file, bytes, "[git]");
  else scan(file, leesTekst(bytes), "[git]");
}

// 2. De gebouwde bundel, als die er is.
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

if (existsSync("dist")) {
  for (const file of walk("dist")) {
    let bytes;
    try {
      bytes = readFileSync(file);
    } catch {
      continue;
    }
    if (BINAIR.test(file)) {
      scanBytes(file, bytes, "[bundel]");
      continue;
    }
    const content = leesTekst(bytes);
    scan(file, content, "[bundel]");
    if (/service_role/.test(content)) {
      problems.push(`[bundel] ${file}: de tekst "service_role" staat in de bundel`);
    }
  }
} else {
  console.log(
    "i dist/ bestaat niet, alleen de repo gecontroleerd (draai `pnpm build` voor de bundelcheck)",
  );
}

if (problems.length === 0) pass("geen geheimen gevonden in de repo of de bundel");

fail("Er staat mogelijk een geheime sleutel in de repo of in de bundel.", [
  ...problems.map((problem) => `- ${problem}`),
  "",
  "Wat nu:",
  "  - Staat het in de bundel? Dan hoort die sleutel niet in een VITE_-variabele.",
  "    Verplaats de aanroep naar een Supabase Edge Function.",
  "  - Staat het in git? Verwijder hem én draai de sleutel om. Wat één keer",
  "    gepusht is, is gelekt, ook na een revert.",
  "  - Vals alarm? Zet `guard-secrets:allow` als commentaar op die regel.",
]);
