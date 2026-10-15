import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  changedFiles,
  fail,
  herstartNaPrTekst,
  pass,
  pullRequestBody,
  resolveBase,
  skip,
} from "./lib/changed-files.mjs";

/**
 * De bestanden van de gedeelde template worden niet per project gewijzigd.
 *
 * Waarom dit een check is en niet alleen een hook: de hook van de Stage Two-plugin
 * werkt alleen in Claude Code, en alleen als de plugin geïnstalleerd is. Een andere
 * agent, of een mens in een editor, kan ci.yml of een guard aanpassen, en op een pull
 * request draait GitHub de workflow van de branch zelf. Deze check maakt dat zichtbaar
 * vóór de merge, voor elke agent, en lokaal via `pnpm check` al vóór de push. Dit is
 * de harde grens; de plugin maakt hem alleen eerder merkbaar.
 *
 * Wat "van de template" is staat in .claude/stack-manifest.json, dezelfde lijst die
 * /stagetwo-tier2:updaten gebruikt. Bij AGENTS.md telt alleen het deel tussen de markeringen:
 * alles erboven is van het project.
 *
 * Ontsnappingsluik, expres zichtbaar: de regel `Bevestigd: templatebestanden gewijzigd`
 * in de PR-tekst. /stagetwo-tier2:updaten zet die regel zelf in zijn pull requests.
 *
 * Wat deze check niet kan: zichzelf beschermen. Wie ci.yml wijzigt kan deze stap
 * weghalen. Dat staat zo in de PR-diff, de klant leest die vóór de merge, en de
 * volgende /stagetwo-tier2:updaten meldt de afwijking. Het doel is de improviserende agent,
 * niet de kwaadwillende mens.
 */
const BEVESTIGING = /^\s*Bevestigd:\s*templatebestanden gewijzigd\s*$/im;

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

// In de templates zelf (ook onder hun oude namen), en in de spiegel daarvan bij
// een klant, is elke wijziging aan deze bestanden juist de bedoeling.
const repo =
  process.env.GITHUB_REPOSITORY ??
  (() => {
    try {
      return git(["remote", "get-url", "origin"]).trim();
    } catch {
      return "";
    }
  })();
if (/\/(?:app-template-tier[12]|stack-template(?:-cloudflare|-light)?)(?:\.git)?$/.test(repo))
  skip("dit is de template zelf");

let manifest;
try {
  manifest = JSON.parse(readFileSync(".claude/stack-manifest.json", "utf8"));
} catch {
  skip("geen .claude/stack-manifest.json gevonden");
}

const files = changedFiles();
if (files === null) skip("geen basis om mee te vergelijken");

const vervangen = new Set(manifest.vanDeTemplate?.vervangen ?? []);
const markeringen = manifest.vanDeTemplate?.tussenMarkeringen ?? {};

/** Het stuk tussen <!-- naam:begin --> en <!-- naam:end -->, of null als het ontbreekt. */
function gemarkeerdDeel(tekst, naam) {
  const a = tekst.indexOf(`<!-- ${naam}:begin -->`);
  const b = tekst.indexOf(`<!-- ${naam}:end -->`);
  return a === -1 || b === -1 || b < a ? null : tekst.slice(a, b);
}

function opBasis(pad) {
  try {
    return git(["show", `${resolveBase()}:${pad}`]);
  } catch {
    return null;
  }
}

const geraakt = [];
for (const file of files) {
  if (vervangen.has(file)) {
    geraakt.push(file);
    continue;
  }
  const naam = markeringen[file];
  if (!naam) continue;
  const oud = opBasis(file);
  if (oud === null) continue; // nieuw bestand: dat regelt /stagetwo-tier2:updaten of het opzetscript
  const nu = readFileSync(file, "utf8");
  const oudDeel = gemarkeerdDeel(oud, naam);
  const nuDeel = gemarkeerdDeel(nu, naam);
  if (nuDeel === null) geraakt.push(`${file} (markeringen ${naam}:begin/${naam}:end weg)`);
  else if (oudDeel !== null && oudDeel !== nuDeel) geraakt.push(`${file} (tussen de markeringen)`);
}

if (geraakt.length === 0) pass("geen bestanden van de gedeelde template gewijzigd");

const bevestigd = BEVESTIGING.test(pullRequestBody());
if (bevestigd) pass(`templatebestanden gewijzigd met expliciete bevestiging (${geraakt.length})`);

fail("Deze PR wijzigt bestanden die van de gedeelde template zijn.", [
  ...geraakt.map((file) => `- ${file}`),
  "",
  "Die bestanden komen uit de app-template van Stage Two en worden per project niet gewijzigd:",
  "/stagetwo-tier2:updaten brengt verbeteringen als pull request naar élk project, en meldt",
  "een lokale afwijking bij de volgende update. Wat je hier verandert, geeft dit project",
  "andere afspraken dan de rest, en het komt bij elke update opnieuw ter sprake.",
  "",
  "Doe één van beide:",
  "  1. Draai de wijziging terug en meld bij Stage Two wat er niet klopt (voorkeur):",
  "     dan krijgt elk project de verbetering, of",
  "  2. zet, als het echt bewust is, deze regel exact zo in de PR-tekst:",
  "     `Bevestigd: templatebestanden gewijzigd`",
  ...herstartNaPrTekst,
]);
