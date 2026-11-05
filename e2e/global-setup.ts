import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { databaseModus } from "./stack-config";
import { TEST_USER } from "./test-user";

/**
 * Alleen een app met een eigen database heeft een eigen gebruikersadministratie om
 * een testgebruiker in aan te maken. Zonder database is er niets in te loggen, en bij
 * een gedeelde database staan de gebruikers in het project van een andere app en gaan
 * we daar niets aanmaken.
 */
function heeftEigenGebruikers(): boolean {
  return databaseModus() === "eigen";
}

/**
 * Maakt de testgebruiker aan voordat de end-to-end tests draaien. Zo heeft de test
 * geen handmatig aangemaakt account nodig en geen wachtwoord in de repo-secrets:
 * de omgeving maakt zichzelf.
 */
export default async function globalSetup(): Promise<void> {
  if (!heeftEigenGebruikers()) return;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "SUPABASE_URL of SUPABASE_SERVICE_ROLE_KEY ontbreekt. Draai `pnpm db:start` en daarna `pnpm env:local`.",
    );
  }

  const admin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: existing } = await admin.auth.admin.listUsers();
  const found = existing?.users.find((user) => user.email === TEST_USER.email);
  if (found) {
    await admin.auth.admin.deleteUser(found.id);
  }

  const { error } = await admin.auth.admin.createUser({
    email: TEST_USER.email,
    password: TEST_USER.password,
    email_confirm: true,
  });
  if (error) throw new Error(`Kon de testgebruiker niet aanmaken: ${error.message}`);

  geefTestrol();
}

/**
 * Heeft de app rollen, dan ziet een gebruiker zonder rol niets, en opent de browsertest per
 * onderdeel (e2e/onderdelen.spec.ts) alleen lege schermen. supabase/testrol.sql geeft de
 * testgebruiker van de testdatabase (testgebruiker@stagetwo.nl) dezelfde rol als de bouwer;
 * hier draait hetzelfde bestand voor de e2e-gebruiker, op de lokale database. Zo test de
 * browsertest meteen of testrol.sql klopt.
 */
function geefTestrol(): void {
  const bestand = "supabase/testrol.sql";
  if (!existsSync(bestand)) return;
  const adres = process.env.SUPABASE_DB_URL;
  if (!adres) {
    throw new Error(
      "SUPABASE_DB_URL ontbreekt, dus supabase/testrol.sql kan niet draaien. Draai `pnpm env:local` opnieuw.",
    );
  }
  const sql = readFileSync(bestand, "utf8").replaceAll(
    "testgebruiker@stagetwo.nl",
    TEST_USER.email,
  );
  execFileSync("psql", [adres, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    input: sql,
    stdio: ["pipe", "inherit", "inherit"],
  });
}
