import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/** Unittests: draaien in een nagebootste browser, zonder database. */
export default defineConfig({
  plugins: [react()],
  // Geen .env-bestanden lezen: na `pnpm env:test` staat in .env.local de testdatabase, en de
  // unittests horen daar niet van af te hangen. De waarden staan hieronder.
  envDir: false,
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
    include: ["src/**/*.test.{ts,tsx}", "tests/unit/**/*.test.{ts,tsx}"],
    setupFiles: ["./tests/setup.ts"],
    env: {
      // Nepwaarden: de unittests praten niet met een echte Supabase.
      VITE_SUPABASE_URL: "http://127.0.0.1:54321",
      VITE_SUPABASE_ANON_KEY: "test-anon-key-alleen-voor-unittests",
    },
  },
});
