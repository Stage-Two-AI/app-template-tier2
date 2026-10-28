import { z } from "zod";
import { INLOGDIENSTEN } from "@/features/auth/inlogdienst";

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
     * `wachtwoord`, zodat lokaal en in CI alles werkt zoals altijd. In productie zet de
     * uitrol hem op `cloudflare`.
     */
    VITE_INLOGDIENST: z.enum(INLOGDIENSTEN).default("wachtwoord"),
    /**
     * Waar fouten uit de app naartoe gaan (Sentry). Leeg of afwezig: Sentry staat uit.
     * Een DSN is publiek, hij staat toch in de bundel. Bewust geen URL-controle: een
     * verkeerde DSN mag de app niet laten crashen; src/lib/fouten.ts vangt die af.
     */
    VITE_SENTRY_DSN: z.string().optional(),
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

if (!parsed.success) {
  const details = parsed.error.issues.map((issue) => `- ${issue.message}`).join("\n");
  throw new Error(
    `De omgevingsvariabelen kloppen niet:\n${details}\n\nKopieer .env.example naar .env.local en vul de waarden in, of draai \`pnpm env:local\` als je lokaal met Supabase werkt.`,
  );
}

export const env = parsed.data;

/**
 * Heeft deze build een database? Zonder de Supabase-waarden niet, en dan toont de app
 * de startpagina in plaats van het inlogscherm. Dat is de stand van een verse app
 * met `"database": false`, en van elke app tot Stage Two de database heeft gekoppeld.
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
