import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * De testlogin (`pnpm testlogin`) staat in .env.development.local, dat Vite alleen in de
 * dev-server leest. Dit is een extra slot: staat hij toch ergens anders (in .env.local of
 * in de omgeving, zoals bij `pnpm test:e2e`, dat .env.local inleest), dan komt hij bij het
 * bouwen niet in de gebouwde bestanden. Een waarde in process.env gaat bij Vite vóór elk
 * .env-bestand, dus leeg maken vóór het bouwen houdt hem eruit.
 */
export const ALLEEN_DEV = ["VITE_TESTLOGIN_EMAIL", "VITE_TESTLOGIN_WACHTWOORD"];

export default defineConfig(({ command }) => {
  if (command !== "serve") for (const naam of ALLEEN_DEV) process.env[naam] = "";
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    server: { port: 5173 },
    preview: { port: 4173 },
  };
});
