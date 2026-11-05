import { execFileSync } from "node:child_process";

/**
 * Een vraag rechtstreeks aan de lokale database, voor wat de Supabase-client niet kan zien:
 * de policies (`pg_policies`) en de rechten van rollen. Via `psql`, dat op de runners van
 * GitHub al staat; het adres schrijft `pnpm env:local` als SUPABASE_DB_URL in .env.test.
 *
 * Alleen voor de lokale database in de RLS-tests, nooit voor een database in de cloud.
 */
export function vraagDatabase<T>(sql: string): T[] {
  const adres = import.meta.env.SUPABASE_DB_URL ?? process.env.SUPABASE_DB_URL;
  if (!adres) {
    throw new Error(
      "SUPABASE_DB_URL ontbreekt. Draai `pnpm db:start` en daarna `pnpm env:local` voordat je de RLS-tests draait.",
    );
  }
  if (!/@(?:127\.0\.0\.1|localhost):/.test(adres)) {
    throw new Error(
      "SUPABASE_DB_URL wijst niet naar de lokale database; deze tests draaien alleen lokaal.",
    );
  }
  const uitvoer = execFileSync(
    "psql",
    [
      adres,
      "-X",
      "-q",
      "-A",
      "-t",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `select coalesce(json_agg(t), '[]') from (${sql}) t`,
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(uitvoer.trim() || "[]") as T[];
}
