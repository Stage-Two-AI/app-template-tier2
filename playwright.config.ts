import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";
import { databaseModus } from "./e2e/stack-config";

// De testomgeving wordt geschreven door `pnpm env:local` en staat niet in git.
if (existsSync(".env.test")) process.loadEnvFile(".env.test");
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const PORT = 4173;

/**
 * Dezelfde app nog een keer gebouwd, maar dan als klantportaal
 * (`VITE_INLOGDIENST=cloudflare,mailcode`), op een eigen poort. e2e/klantportaal.spec.ts logt
 * daar echt in met de code uit de lokale mailvanger, op het formaat van een telefoon. De
 * gewone tests draaien tegen de gewone build en merken hier niets van. Alleen bij een eigen
 * database: zonder is er niets om in te loggen.
 */
const PORT_KLANTPORTAAL = 4174;
const KLANTPORTAAL = /klantportaal\.spec\.ts$/;
const metKlantportaal = databaseModus() === "eigen";

function omgevingMet(extra: Record<string, string>): Record<string, string> {
  const omgeving: Record<string, string> = {};
  for (const [naam, waarde] of Object.entries(process.env)) {
    if (waarde !== undefined) omgeving[naam] = waarde;
  }
  return { ...omgeving, ...extra };
}

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: KLANTPORTAAL },
    ...(metKlantportaal
      ? [
          {
            name: "klantportaal",
            testMatch: KLANTPORTAAL,
            use: { ...devices["Pixel 7"], baseURL: `http://127.0.0.1:${PORT_KLANTPORTAAL}` },
          },
        ]
      : []),
  ],
  webServer: [
    {
      // Bewust de gebouwde app, niet de dev-server: je test wat er ook echt live gaat.
      // De poort staat in het preview-script; hier niet nog eens meegeven, want dan
      // krijgt Vite de vlag dubbel en bindt hij op een andere poort.
      command: "pnpm build && pnpm preview",
      url: `http://127.0.0.1:${PORT}`,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 180_000,
    },
    ...(metKlantportaal
      ? [
          {
            command: `pnpm build --outDir dist-klantportaal && pnpm exec vite preview --outDir dist-klantportaal --port ${PORT_KLANTPORTAAL} --host 127.0.0.1 --strictPort`,
            env: omgevingMet({ VITE_INLOGDIENST: "cloudflare,mailcode" }),
            url: `http://127.0.0.1:${PORT_KLANTPORTAAL}`,
            reuseExistingServer: !process.env.CI,
            stdout: "pipe" as const,
            stderr: "pipe" as const,
            timeout: 180_000,
          },
        ]
      : []),
  ],
});
