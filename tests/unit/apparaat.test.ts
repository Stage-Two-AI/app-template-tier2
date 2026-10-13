import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KOP, vingerafdruk, welkApparaat } from "../../supabase/functions/_shared/apparaat";

const SCRIPT = resolve("scripts/apparaat-nieuw.mjs");
const SLEUTEL = "a".repeat(43);
const afdruk = (s: string) => createHash("sha256").update(s).digest("hex");
const verzoek = (sleutel?: string) =>
  new Request("https://x.supabase.co/functions/v1/f", {
    headers: sleutel ? { [KOP]: sleutel } : {},
  });

describe("apparaatsleutels in de functie", () => {
  it("de vingerafdruk is SHA-256 in hex, net als in het script", async () => {
    expect(await vingerafdruk(SLEUTEL)).toBe(afdruk(SLEUTEL));
  });

  it("herkent een apparaat aan zijn sleutel, en verder niets", async () => {
    const lijst = [{ naam: "pi", sha256: afdruk(SLEUTEL) }];
    expect(await welkApparaat(verzoek(SLEUTEL), ["pi"], lijst)).toBe("pi");
    expect(await welkApparaat(verzoek("b".repeat(43)), ["pi"], lijst)).toBeNull();
    expect(await welkApparaat(verzoek(), ["pi"], lijst)).toBeNull();
    const kort = [{ naam: "kort", sha256: afdruk("kort") }];
    expect(await welkApparaat(verzoek("kort"), ["kort"], kort)).toBeNull();
    expect(await welkApparaat(verzoek(SLEUTEL), ["pi"], [])).toBeNull();
  });

  it("een geldig apparaat dat niet bij deze functie hoort, wordt geweigerd", async () => {
    const lijst = [{ naam: "pi", sha256: afdruk(SLEUTEL) }];
    expect(await welkApparaat(verzoek(SLEUTEL), ["server"], lijst)).toBeNull();
    expect(await welkApparaat(verzoek(SLEUTEL), [], lijst)).toBeNull();
  });
});

describe("pnpm apparaat:nieuw", () => {
  let map = "";
  afterEach(() => map && rmSync(map, { recursive: true, force: true }));

  function opzet() {
    map = mkdtempSync(join(tmpdir(), "apparaat-"));
    mkdirSync(join(map, "supabase/functions/_shared"), { recursive: true });
    writeFileSync(join(map, "supabase/functions/_shared/apparaten.json"), '{"apparaten": []}\n');
  }
  const draai = (...args: string[]) =>
    spawnSync("node", [SCRIPT, ...args], { cwd: map, encoding: "utf8" });
  const lijst = (): { naam: string; sha256: string }[] =>
    JSON.parse(readFileSync(join(map, "supabase/functions/_shared/apparaten.json"), "utf8"))
      .apparaten;

  it("toont de sleutel één keer en bewaart alleen de vingerafdruk", () => {
    opzet();
    const r = draai("pi");
    expect(r.status).toBe(0);
    const sleutel = r.stdout.match(/^ {2}([A-Za-z0-9_-]{43})$/m)?.[1] ?? "";
    expect(sleutel).toHaveLength(43);
    expect(lijst()).toEqual([{ naam: "pi", sha256: afdruk(sleutel) }]);
    expect(
      readFileSync(join(map, "supabase/functions/_shared/apparaten.json"), "utf8"),
    ).not.toContain(sleutel);
  });

  it("weigert een dubbele of ongeldige naam; intrekken haalt alleen dat apparaat weg", () => {
    opzet();
    expect(draai("pi").status).toBe(0);
    expect(draai("pi").stderr).toMatch(/bestaat al/);
    expect(draai("Pi Kantoor").stderr).toMatch(/ongeldige naam/);
    expect(draai("server").status).toBe(0);
    expect(draai("--intrekken", "pi").status).toBe(0);
    expect(lijst().map((a) => a.naam)).toEqual(["server"]);
    expect(draai("--intrekken", "pi").stderr).toMatch(/staat er niet in/);
  });

  it("een app van vóór versie 17 krijgt de lijst bij het eerste apparaat", () => {
    map = mkdtempSync(join(tmpdir(), "apparaat-"));
    expect(draai("pi").status).toBe(0);
    expect(lijst().map((a) => a.naam)).toEqual(["pi"]);
  });
});
