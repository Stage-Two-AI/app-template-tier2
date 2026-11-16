import { z } from "zod";
import { leesInlogdiensten } from "@/features/auth/inlogdienst";

/**
 * Zod zonder `eval`. Zod 4 probeert bij het eerste objectschema of hij code mag maken met
 * `new Function` (dat maakt controleren iets sneller). De Content-Security-Policy van de app
 * verbiedt dat, en de browser meldt elke poging, ook als Zod de weigering netjes opvangt. Dit
 * bestand is het eerste dat een schema maakt (src/root.tsx laadt het, vóór elke pagina), in de
 * browser én op de server; daarom staat de instelling hier, één keer, boven het eerste schema.
 */
z.config({ jitless: true });

/**
 * Omgevingsvariabelen worden hier één keer gevalideerd, bij het opstarten van de app.
 * Zo krijg je een begrijpelijke foutmelding in plaats van een `undefined` die pas
 * drie schermen verderop stukloopt.
 *
 * Alles met de prefix VITE_ zit in de gedownloade bundel en is dus publiek.
 * Zet hier nooit een geheime sleutel neer; zie docs/WERKWIJZE.md.
 */
/**
 * Een lege variabele betekent hetzelfde als een afwezige. GitHub Actions geeft een
 * niet-ingestelde `${{ vars.X }}` door als lege tekst, en een lege regel in .env.local
 * doet hetzelfde; zonder deze stap zou de app daarop crashen.
 */
function leegIsAfwezig(waarden: unknown): unknown {
  if (typeof waarden !== "object" || waarden === null) return waarden;
  return Object.fromEntries(Object.entries(waarden).filter(([, waarde]) => waarde !== ""));
}

const velden = z
  .object({
    /**
     * De twee Supabase-waarden horen bij elkaar: allebei aanwezig (een app met een
     * database) of allebei afwezig (`"database": false` in stack.config.json; de app
     * draait dan alleen op de hosting en toont de startpagina). Eén van de twee is
     * een fout, en die melden we hieronder.
     */
    VITE_SUPABASE_URL: z.string().min(1).optional(),
    VITE_SUPABASE_ANON_KEY: z.string().min(20, "VITE_SUPABASE_ANON_KEY is te kort").optional(),
    /**
     * Welk databaseschema deze app gebruikt. Een app met een eigen database praat met
     * `public`. Een app die de database van een andere app gebruikt (`"database":
     * "gedeeld"` in stack.config.json) praat uitsluitend met haar contract: het schema
     * `api`. Meer smaken zijn er niet, en dat is opzet.
     */
    VITE_SUPABASE_SCHEMA: z.enum(["public", "api"]).default("public"),
    /**
     * Staat deze versie van de app op de testdatabase? Dan `test`, en de app laat dat
     * zien met een balk bovenin. De uitrol zet dit op de preview, `pnpm env:test`
     * op je eigen computer. In productie ontbreekt hij, en dan is er geen balk.
     */
    VITE_OMGEVING: z.enum(["test"]).optional(),
    /**
     * Hoe gebruikers inloggen; zie src/features/auth/inlogdienst.ts. Standaard
     * `wachtwoord`, zodat lokaal en in de unittests alles werkt zoals altijd. Een gebouwde app
     * met een database zonder deze waarde start niet met een wachtwoordformulier dat nergens
     * werkt, maar met het scherm "Deze app is nog niet ingericht" (zie `inlogNietIngericht`).
     * In productie zet de uitrol hem op `cloudflare,mailcode`. Een klantportaal noemt er twee, met een komma ertussen:
     * `cloudflare,mailcode` (medewerkers via Cloudflare, klanten met een code per mail).
     * De waarde blijft hier de tekst zoals hij is opgegeven; `inlogdiensten` hieronder is
     * de lijst die de app gebruikt.
     */
    VITE_INLOGDIENST: z.string().default("wachtwoord"),
    /**
     * Waar fouten uit de app naartoe gaan (Sentry). Leeg of afwezig: Sentry staat uit.
     * Een DSN is publiek, hij staat toch in de bundel. Bewust geen URL-controle: een
     * verkeerde DSN mag de app niet laten crashen; src/lib/fouten.ts vangt die af.
     */
    VITE_SENTRY_DSN: z.string().optional(),
    /**
     * De openbare sleutel (sitekey) van Cloudflare Turnstile: de controle tegen robots op het
     * inlogformulier voor klanten (src/features/auth/robotcontrole.ts). Leeg of afwezig: de
     * controle staat uit en er verandert niets. Hoort bij de schakelaar `captcha` van de
     * inrichting: staat de controle bij Supabase aan, dan moet deze sleutel er zijn, anders
     * kan geen klant meer een code aanvragen.
     */
    VITE_TURNSTILE_SITEKEY: z.string().optional(),
    /**
     * De testlogin: e-mail en wachtwoord van de vaste testgebruiker in de testdatabase.
     * `pnpm testlogin` zet ze in .env.development.local (het wachtwoord wordt elke nacht
     * vernieuwd); dat bestand leest Vite alleen in de dev-server.
     * Alleen de dev-server op je eigen computer gebruikt ze (zie testloginVoorDev);
     * vite.config.ts maakt ze leeg bij elke build, zodat ze nooit in een gebouwde versie
     * staan.
     */
    VITE_TESTLOGIN_EMAIL: z.string().optional(),
    VITE_TESTLOGIN_WACHTWOORD: z.string().optional(),
  })
  .superRefine((waarden, ctx) => {
    const diensten = leesInlogdiensten(waarden.VITE_INLOGDIENST);
    if (!diensten.ok) ctx.addIssue({ code: "custom", message: diensten.fout });

    const url = Boolean(waarden.VITE_SUPABASE_URL);
    const sleutel = Boolean(waarden.VITE_SUPABASE_ANON_KEY);
    if (url !== sleutel) {
      ctx.addIssue({
        code: "custom",
        message: url ? "VITE_SUPABASE_ANON_KEY ontbreekt" : "VITE_SUPABASE_URL ontbreekt",
      });
    }
  });

export const envSchema = z.preprocess(leegIsAfwezig, velden);

const parsed = envSchema.safeParse(import.meta.env);

/**
 * Kloppen de omgevingsvariabelen niet (bijvoorbeeld een onbekende dienst in
 * `VITE_INLOGDIENST`), dan staat hier wat er mis is, in gewone taal. De app gooit dan geen
 * fout bij het laden: de server maakt de pagina's, en een fout hier zou elke pagina een kale
 * serverfout geven. src/root.tsx toont in plaats daarvan op elk adres het scherm "Deze app
 * kan niet starten" met deze tekst (zie src/lib/startfout.tsx). Er staan alleen namen van
 * openbare variabelen in, geen waarden.
 */
export const envFout: string | null = parsed.success
  ? inlogNietIngericht(import.meta.env, import.meta.env.MODE)
  : `De omgevingsvariabelen kloppen niet:\n${parsed.error.issues
      .map((issue) => `- ${issue.message}`)
      .join(
        "\n",
      )}\n\nKopieer .env.example naar .env.local en vul de waarden in, of draai \`pnpm env:local\` als je lokaal met Supabase werkt.`;

export const NIET_INGERICHT = "Deze app is nog niet ingericht";

/**
 * Een gebouwde app (productie, een preview) met een database, maar zonder keuze hoe mensen
 * inloggen: dan is de app niet (helemaal) ingericht. Zonder deze controle zou hij het
 * wachtwoordformulier tonen, dat online nergens werkt. Lokaal (de dev-server) en in de
 * unittests blijft het wachtwoord de standaard, voor de testlogin.
 */
export function inlogNietIngericht(waarden: Record<string, unknown>, mode: string): string | null {
  const tekst = (w: unknown) => (typeof w === "string" ? w.trim() : "");
  if (mode !== "production") return null;
  if (tekst(waarden.VITE_SUPABASE_URL) === "") return null;
  if (tekst(waarden.VITE_INLOGDIENST) !== "") return null;
  return `${NIET_INGERICHT}: er is nog niet gekozen hoe mensen inloggen (VITE_INLOGDIENST ontbreekt). Dat zet App inrichten in de beheer-repo goed; vraag de owner om de app in te richten.`;
}

/** Bij een fout: de standaardwaarden (geen database), zodat de rest van de code kan laden. */
export const env = parsed.success ? parsed.data : envSchema.parse({});

/**
 * De inlogdiensten van deze build, in de volgorde van `VITE_INLOGDIENST`. Meestal één; bij
 * een klantportaal meer. De controle hierboven heeft de waarde al goedgekeurd, dus een fout
 * kan hier niet meer voorkomen; de terugval is er alleen voor de typecontrole.
 */
const gelezen = leesInlogdiensten(env.VITE_INLOGDIENST);
export const inlogdiensten = gelezen.ok ? gelezen.diensten : ["wachtwoord" as const];

/**
 * Heeft deze build een database? Zonder de Supabase-waarden niet, en dan toont de app
 * de startpagina in plaats van het inlogscherm. Dat is de stand van een verse app
 * met `"database": false`, en van elke app tot de database is gekoppeld (App inrichten in de beheer-repo).
 */
export const heeftDatabase = Boolean(env.VITE_SUPABASE_URL && env.VITE_SUPABASE_ANON_KEY);

/**
 * De testlogin, alleen in de dev-server (`import.meta.env.DEV`) en alleen als e-mail én
 * wachtwoord er zijn. In een gebouwde versie altijd null.
 */
export function testloginVoorDev(
  waarden: Pick<typeof env, "VITE_TESTLOGIN_EMAIL" | "VITE_TESTLOGIN_WACHTWOORD"> = env,
  dev: boolean = import.meta.env.DEV,
): { email: string; wachtwoord: string } | null {
  if (!dev) return null;
  const email = waarden.VITE_TESTLOGIN_EMAIL;
  const wachtwoord = waarden.VITE_TESTLOGIN_WACHTWOORD;
  return email && wachtwoord ? { email, wachtwoord } : null;
}
