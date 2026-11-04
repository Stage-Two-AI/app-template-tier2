import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * RLS-tests: draaien tegen een échte (lokale) Supabase, want beveiligingsregels
 * kun je niet nabootsen. Start de database met `pnpm db:start` en schrijf de
 * omgevingsvariabelen weg met `pnpm env:local`.
 */
export default defineConfig({
  // Dezelfde alias als de unittests, zodat een RLS-test gewone code uit de app kan importeren.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  envPrefix: ["VITE_", "SUPABASE_"],
  test: {
    environment: "node",
    include: ["tests/rls/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
