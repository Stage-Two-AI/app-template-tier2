import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * De testlogin (`pnpm testlogin`) blijft buiten de gebouwde bestanden; zie
 * scripts/bouwen.mjs, dat `pnpm build` draait. Dit is hetzelfde slot voor wie
 * `vite build` direct aanroept.
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
