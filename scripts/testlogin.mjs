import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { testDatabase } from "./lib/stack-config.mjs";

/**
 * Haalt de testlogin op: e-mail en wachtwoord van de vaste testgebruiker in de
 * testdatabase, zodat de app op deze computer (en Claude in de preview) kan inloggen
 * zonder Cloudflare. `pnpm env:test` en de preview van de Claude-app roepen dit zelf aan.
 *
 * Waar het vandaan komt: de beheer-repo maakt elke nacht (Testdatabase verversen) een
 * nieuw wachtwoord en zet het klaar als artifact `testlogin-<app>`, een paar dagen
 * bewaard. Dit script haalt het nieuwste op met `gh`, waarmee je al bent ingelogd. Wie
 * bij de beheer-repo mag, kan het ophalen; verder is er niets bij te houden.
 *
 * Welke beheer-repo: STAGETWO_BEHEER_REPO als die gezet is (`naam` of `org/naam`), anders
 * de repo in de org die eindigt op `-beheer-tier2`; zijn dat er meer, dan die met de app in
 * toegang.json. De org en de naam van de app komen uit de git-remote (`origin`): de
 * app heet in toegang.json zoals haar repo.
 *
 * Het zet alleen deze regels in .env.development.local (mode 600) en laat de rest staan:
 *   VITE_TESTLOGIN_EMAIL, VITE_TESTLOGIN_WACHTWOORD, VITE_INLOGDIENST=wachtwoord
 * Vite leest dat bestand alleen in de dev-server (de preview in de Claude-app), nooit bij
 * een build of in de tests. Zo komt het wachtwoord nooit in een gebouwde app, ook niet in
 * een app met een oudere vite.config.ts. Het gaat ook vóór .env.local, dus
 * VITE_INLOGDIENST=wachtwoord geldt lokaal, hoe .env.local ook staat.
 * Alleen als .env.local naar de testdatabase van deze app wijst, en het artifact bij
 * dezelfde testdatabase hoort. Nooit productie. Een eerdere versie zette de testlogin in
 * .env.local; die regels haalt het daar weg.
 *
 * Voor de tests: STAGETWO_GH wijst naar een Node-script dat zich voordoet als `gh`.
 */

export const SLEUTELS = ["VITE_TESTLOGIN_EMAIL", "VITE_TESTLOGIN_WACHTWOORD", "VITE_INLOGDIENST"];

/** Waar de testlogin staat: alleen de dev-server van Vite leest dit bestand. */
export const BESTAND = ".env.development.local";

const KOP =
  "# Testlogin (`pnpm testlogin`): de testgebruiker van de testdatabase, elke nacht vernieuwd.";

class Melding extends Error {}

function stop(...regels) {
  throw new Melding(regels.join("\n"));
}

/** `gh` met deze argumenten; geeft stdout, of gooit met de foutmelding van gh. */
function gh(args) {
  const nep = process.env.STAGETWO_GH;
  // Op Windows is gh een .exe op het PATH; zonder shell vindt spawnSync die gewoon.
  const r = nep
    ? spawnSync(process.execPath, [nep, ...args], { encoding: "utf8", timeout: 60_000 })
    : spawnSync("gh", args, { encoding: "utf8", timeout: 60_000 });
  if (r.error) {
    if (r.error.code === "ENOENT") {
      stop("`gh` (de GitHub-CLI) staat niet op deze computer. Draai /stagetwo-tier2:installatie.");
    }
    stop(`gh ${args[0]} lukte niet: ${r.error.message}`);
  }
  if (r.status !== 0) {
    const fout = (r.stderr || r.stdout || "").trim().split("\n")[0] ?? "";
    const err = new Error(`gh ${args.slice(0, 2).join(" ")}: ${fout}`);
    err.ghFout = fout;
    throw err;
  }
  return r.stdout;
}

/** `org/naam` uit een git-remote (https of ssh), of null. */
export function repoUitRemote(remote) {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(String(remote ?? "").trim());
  return m ? { org: m[1], repo: m[2] } : null;
}

function eigenRepo() {
  let remote = "";
  try {
    remote = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    stop(
      "Deze map heeft geen git-remote `origin`, dus ik weet niet bij welke organisatie de app hoort.",
    );
  }
  const r = repoUitRemote(remote);
  if (!r) stop(`De git-remote ${remote.trim()} is geen repo op GitHub.`);
  return r;
}

/**
 * De beheer-repo waar deze app in staat, als `org/naam`: STAGETWO_BEHEER_REPO als die gezet
 * is, anders de repo's in de org die eindigen op `-beheer-tier2` (`stagetwo-beheer-tier2`
 * ook). Is er één, dan die; zijn er meer, dan de enige met de app in toegang.json.
 */
export function vindBeheerRepo(org, app, { omgeving = process.env } = {}) {
  const gezet = (omgeving.STAGETWO_BEHEER_REPO ?? "").trim();
  if (gezet) return gezet.includes("/") ? gezet : `${org}/${gezet}`;
  let lijst;
  try {
    lijst = JSON.parse(gh(["repo", "list", org, "--limit", "1000", "--json", "name"]) || "[]");
  } catch (fout) {
    if (fout instanceof Melding) throw fout;
    stop(
      `Kon de beheer-repo niet opzoeken (${fout.message}).`,
      "Ben je offline, of niet ingelogd bij GitHub? Probeer `gh auth status`.",
    );
  }
  const kandidaten = lijst.map((r) => r.name).filter((n) => n.endsWith("-beheer-tier2"));
  if (kandidaten.length === 1) return `${org}/${kandidaten[0]}`;
  if (kandidaten.length === 0) {
    stop(
      `Geen beheer-repo gevonden in ${org} (stagetwo-beheer-tier2, of een naam die eindigt op -beheer-tier2).`,
      "Heb je toegang tot de beheer-repo? Anders: zet STAGETWO_BEHEER_REPO=<naam>.",
    );
  }
  const metApp = kandidaten.filter((n) => staatInToegang(`${org}/${n}`, app));
  if (metApp.length === 1) return `${org}/${metApp[0]}`;
  stop(
    metApp.length === 0
      ? `${app} staat in geen van de beheer-repo's in ${org}: ${kandidaten.join(", ")}.`
      : `${app} staat in meer dan één beheer-repo in ${org}: ${metApp.join(", ")}.`,
    "Kies er één met STAGETWO_BEHEER_REPO=<naam>.",
  );
}

/** Staat `app` in toegang.json van `repo` onder `apps`? Niet te lezen telt als nee. */
function staatInToegang(repo, app) {
  try {
    const toegang = JSON.parse(
      gh([
        "api",
        `repos/${repo}/contents/toegang.json`,
        "-H",
        "Accept: application/vnd.github.raw",
      ]),
    );
    return Object.hasOwn(toegang?.apps ?? {}, app);
  } catch (fout) {
    if (fout instanceof Melding) throw fout;
    return false;
  }
}

/** Het nieuwste artifact `testlogin-<app>` dat nog niet verlopen is, of null. */
export function nieuwsteArtifact(artifacts, naam) {
  return (
    (artifacts ?? [])
      .filter((a) => a.name === naam && !a.expired)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] ?? null
  );
}

/** Een waarde voor een env-bestand: zonder aanhalingstekens als het kan, anders tussen ''. */
export function envWaarde(waarde) {
  const w = String(waarde);
  if (/^[A-Za-z0-9_.@+-]+$/.test(w)) return w;
  if (/['"\\$`\s]/.test(w)) {
    stop(
      `Het wachtwoord uit de testlogin bevat tekens die niet in ${BESTAND} passen; meld dit bij Stage Two.`,
    );
  }
  return `'${w}'`;
}

/** Een env-bestand met deze sleutels gezet (vervangen of erbij), de rest ongewijzigd. */
export function zetSleutels(inhoud, waarden) {
  const regels = inhoud.length ? inhoud.replace(/\n$/, "").split("\n") : [];
  const gedaan = new Set();
  const uit = regels.map((regel) => {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(regel);
    if (!m || !(m[1] in waarden)) return regel;
    gedaan.add(m[1]);
    return `${m[1]}=${waarden[m[1]]}`;
  });
  const nieuw = Object.keys(waarden).filter((k) => !gedaan.has(k));
  if (nieuw.length) {
    if (!uit.includes(KOP)) uit.push(KOP);
    for (const k of nieuw) uit.push(`${k}=${waarden[k]}`);
  }
  return `${uit.join("\n")}\n`;
}

/**
 * .env.local zonder de testlogin: een eerdere versie zette VITE_TESTLOGIN_* daar, en dat
 * bestand leest Vite ook bij een build. VITE_INLOGDIENST blijft staan.
 */
export function zonderTestlogin(inhoud) {
  const regels = inhoud.replace(/\n$/, "").split("\n");
  const over = regels.filter((r) => r !== KOP && !/^\s*VITE_TESTLOGIN_[A-Z]+\s*=/.test(r));
  return over.length === regels.length ? inhoud : `${over.join("\n")}\n`;
}

/** Het adres waar .env.local naar wijst. */
function supabaseUrlIn(inhoud) {
  return (
    /^VITE_SUPABASE_URL=(.*)$/m
      .exec(inhoud)?.[1]
      ?.trim()
      .replace(/^['"]|['"]$/g, "") ?? ""
  );
}

export function haalTestloginOp() {
  let test;
  try {
    test = testDatabase();
  } catch (fout) {
    stop(fout.message);
  }
  if (!test) stop("Deze app heeft geen testdatabase (stack.config.json), dus ook geen testlogin.");
  if (!existsSync(".env.local")) stop("Er is nog geen .env.local. Draai eerst `pnpm env:test`.");
  const inhoud = readFileSync(".env.local", "utf8");
  if (supabaseUrlIn(inhoud) !== test.url) {
    stop(
      `.env.local wijst niet naar de testdatabase van deze app (${test.url}).`,
      "De testlogin hoort alleen bij de testdatabase. Draai `pnpm env:test --overschrijf`.",
    );
  }

  const { org, repo: app } = eigenRepo();
  const beheer = vindBeheerRepo(org, app);
  const naam = `testlogin-${app}`;
  let lijst;
  try {
    lijst = JSON.parse(
      gh(["api", `repos/${beheer}/actions/artifacts?name=${naam}&per_page=30`]) || "{}",
    );
  } catch (fout) {
    if (fout instanceof Melding) throw fout;
    stop(`Kon de artifacts van ${beheer} niet ophalen (${fout.message}).`);
  }
  const artifact = nieuwsteArtifact(lijst.artifacts, naam);
  if (!artifact) {
    stop(
      `Geen geldige ${naam} in ${beheer}.`,
      "Die maakt Testdatabase verversen elke nacht; draai die workflow in de beheer-repo (of vraag Stage Two).",
    );
  }
  const run = artifact.workflow_run?.id;
  if (!run) stop(`Het artifact ${naam} hoort bij geen workflowrun.`);

  const map = mkdtempSync(join(tmpdir(), "testlogin-"));
  let login;
  try {
    try {
      gh(["run", "download", String(run), "--repo", beheer, "--name", naam, "--dir", map]);
    } catch (fout) {
      stop(`Kon ${naam} niet downloaden (${fout.message}).`);
    }
    const pad = join(map, "testlogin.json");
    if (!existsSync(pad)) stop(`In ${naam} staat geen testlogin.json.`);
    login = JSON.parse(readFileSync(pad, "utf8"));
  } finally {
    rmSync(map, { recursive: true, force: true });
  }

  if (login.project_ref !== test.project_ref) {
    stop(
      `De testlogin hoort bij project ${login.project_ref}, maar de testdatabase van deze app is ${test.project_ref}.`,
      "Ik zet hem niet op deze computer. Meld dit bij Stage Two.",
    );
  }
  if (typeof login.email !== "string" || !/^[^@\s]+@[^@\s]+$/.test(login.email)) {
    stop("De testlogin heeft geen geldig e-mailadres.");
  }
  if (typeof login.wachtwoord !== "string" || login.wachtwoord.length < 12) {
    stop("De testlogin heeft geen bruikbaar wachtwoord.");
  }

  const bestaand = existsSync(BESTAND) ? readFileSync(BESTAND, "utf8") : "";
  const nieuw = zetSleutels(bestaand, {
    VITE_TESTLOGIN_EMAIL: envWaarde(login.email),
    VITE_TESTLOGIN_WACHTWOORD: envWaarde(login.wachtwoord),
    VITE_INLOGDIENST: "wachtwoord",
  });
  writeFileSync(BESTAND, nieuw, { mode: 0o600 });
  try {
    chmodSync(BESTAND, 0o600);
  } catch {
    // Windows kent geen rechten op deze manier; daar is dit niet nodig.
  }
  const schoon = zonderTestlogin(inhoud);
  if (schoon !== inhoud) writeFileSync(".env.local", schoon);
  return { email: login.email, beheer, aangemaakt: login.aangemaakt ?? artifact.created_at };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const r = haalTestloginOp();
    console.log(`✓ Testlogin opgehaald uit ${r.beheer}: inloggen als ${r.email}.`);
    console.log(`  Staat in ${BESTAND}. Op het inlogscherm (lokaal): de knop 'Inloggen als`);
    console.log(
      "  testgebruiker', of in een oudere app het formulier met dit adres en wachtwoord.",
    );
  } catch (fout) {
    console.error(`✗ Testlogin niet opgehaald. ${fout.message}`);
    process.exit(1);
  }
}
