import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * De app is te installeren als app op telefoon en computer ("Zet op beginscherm"). Daarvoor
 * moeten het manifest en de icoontjes kloppen, en moet het manifest met het inlogkoekje
 * worden opgehaald: zonder `crossorigin="use-credentials"` vraagt de browser het manifest op
 * zonder koekje, houdt Cloudflare Access het tegen en is de app niet te installeren. Dat zie
 * je lokaal niet (daar is geen Access), dus deze test bewaakt het.
 */
const ROOT = resolve(__dirname, "../..");
const html = readFileSync(resolve(ROOT, "index.html"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(ROOT, "public/manifest.webmanifest"), "utf8"));

describe("installeerbaar", () => {
  it("haalt het manifest op met het inlogkoekje", () => {
    const link = html.match(/<link[^>]*rel="manifest"[^>]*>/)?.[0];
    expect(link).toContain('href="/manifest.webmanifest"');
    expect(link).toContain('crossorigin="use-credentials"');
  });

  it("opent als app, zonder adresbalk", () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
  });

  it("heeft de icoontjes die telefoons en browsers vragen", () => {
    const maten = manifest.icons.map((icoon: { sizes: string }) => icoon.sizes);
    expect(maten).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    for (const icoon of manifest.icons) {
      expect(existsSync(resolve(ROOT, "public", icoon.src.replace(/^\//, "")))).toBe(true);
    }
    expect(html).toContain('rel="apple-touch-icon"');
    expect(existsSync(resolve(ROOT, "public/apple-touch-icon.png"))).toBe(true);
  });
});
