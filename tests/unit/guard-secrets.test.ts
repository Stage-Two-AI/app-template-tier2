import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * guard:secrets draait op alles wat in git staat. Deze test zet een los git-repo neer
 * met één bestand en draait de guard daarin, zoals CI dat doet.
 */
const WORTEL = resolve(__dirname, "../..");
const GUARD = resolve(WORTEL, "scripts/guard-secrets.mjs");

let map: string;

beforeEach(() => {
  map = mkdtempSync(join(tmpdir(), "guard-secrets-"));
  execFileSync("git", ["init", "-q"], { cwd: map });
});

afterEach(() => {
  rmSync(map, { recursive: true, force: true });
});

function metBestand(naam: string, inhoud: string): { code: number | null; uitvoer: string } {
  writeFileSync(join(map, naam), inhoud);
  execFileSync("git", ["add", naam], { cwd: map });
  const r = spawnSync("node", [GUARD], { cwd: map, encoding: "utf8" });
  return { code: r.status, uitvoer: `${r.stdout}${r.stderr}` };
}

describe("guard:secrets en Cloudflare-sleutels", () => {
  it("vindt een Cloudflare-API-sleutel met waarde", () => {
    const r = metBestand("uitrol.sh", `CLOUDFLARE_API_TOKEN=${"a1B2c3D4e5".repeat(4)}\n`);
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("Cloudflare-API-sleutel");
  });

  it("laat een verwijzing naar een secret staan", () => {
    const r = metBestand(
      "uitrollen.yml",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub-expressie, geen JS-template
      "env:\n  CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n",
    );
    expect(r.code).toBe(0);
  });
});

/**
 * Wat een aanvaller in de zustertemplate (uitgave 43) langs de guard kreeg: een databaseadres
 * met wachtwoord, een sleutel van Resend, tekst in UTF-16, en een sleutel in een bestand dat
 * geen tekst is (public/brochure.pdf gaat na de build naar dist/ en naar elke bezoeker). De
 * sleutels zijn nep en worden pas bij het draaien samengesteld.
 */
const b64 = (tekst: string) => Buffer.from(tekst).toString("base64url");
const jwt = (rol: string) =>
  [
    b64('{"alg":"HS256","typ":"JWT"}'),
    b64(JSON.stringify({ iss: "supabase", role: rol })),
    b64("nep-handtekening-voor-de-test"),
  ].join(".");
const GEHEIM = ["sb", "secret", "nepwaardealleenvoordetest"].join("_");
const RESEND = ["re", "Ab12Cd34", "EfGh56IjKl78MnOp90QrSt12"].join("_");
const POSTGRES = [
  "postgresql://postgres.abcdefghijklmnopqrst",
  "Nep-Wachtwoord-123@aws-0-eu.pooler.supabase.com:5432/postgres",
].join(":");

function schrijf(pad: string, inhoud: string | Buffer) {
  mkdirSync(dirname(join(map, pad)), { recursive: true });
  writeFileSync(join(map, pad), inhoud);
}

function guard(): { code: number | null; uitvoer: string } {
  // Zoals in een app: de gebouwde bestanden staan niet in git.
  writeFileSync(join(map, ".gitignore"), "dist/\n");
  execFileSync("git", ["add", "-A"], { cwd: map });
  const r = spawnSync("node", [GUARD], { cwd: map, encoding: "utf8" });
  return { code: r.status, uitvoer: `${r.stdout}${r.stderr}` };
}

/** Wat een echt binair bestand rond de sleutel heeft: willekeurige bytes. */
function binairMet(tekst: string | Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x13, 0x88]),
    typeof tekst === "string" ? Buffer.from(` ${tekst} `, "latin1") : tekst,
    Buffer.from([0x00, 0xfe, 0x01, 0x7f]),
  ]);
}

describe("guard:secrets: databaseadressen en Resend", () => {
  it("vindt een Postgres-adres met wachtwoord, ook als postgres://", () => {
    for (const adres of [POSTGRES, POSTGRES.replace("postgresql://", "postgres://")]) {
      const r = metBestand("migreren.sh", `psql "${adres}" -f dump.sql\n`);
      expect(r.code, adres).not.toBe(0);
      expect(r.uitvoer).toContain("Postgres-adres met wachtwoord");
    }
  });

  it("laat een open plek en de lokale database staan", () => {
    const r = metBestand(
      "uitleg.md",
      [
        "postgresql://postgres.<ref>:<ww>@<pooler>:5432/postgres",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: zo staat het in een script
        "postgresql://postgres:${ww}@db.${ref}.supabase.co:5432/postgres",
        "postgresql://postgres:$WACHTWOORD@db.abcd.supabase.co:5432/postgres",
        "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
        "postgres://postgres:postgres@localhost:5432/postgres",
        "postgresql://postgres@db.abcd.supabase.co:5432/postgres",
      ].join("\n"),
    );
    expect(r.code, r.uitvoer).toBe(0);
  });

  it("vindt een sleutel van Resend, en niet een naam die met re_ begint", () => {
    const r = metBestand("mail.ts", `const sleutel = "${RESEND}";\n`);
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("Resend-sleutel");
    const goed = metBestand("mail.ts", "re_render(); const re_GeheimeSleutelVanResend123 = 1;\n");
    expect(goed.code, goed.uitvoer).toBe(0);
  });
});

describe("guard:secrets: tekst in UTF-16", () => {
  const varianten: Array<[string, Buffer]> = [
    [
      "UTF-16LE met BOM",
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`SLEUTEL=${GEHEIM}\r\n`, "utf16le")]),
    ],
    ["UTF-16LE zonder BOM", Buffer.from(`SLEUTEL=${GEHEIM}\r\n`, "utf16le")],
    [
      "UTF-16BE met BOM",
      Buffer.concat([
        Buffer.from([0xfe, 0xff]),
        Buffer.from(`SLEUTEL=${GEHEIM}\r\n`, "utf16le").swap16(),
      ]),
    ],
    ["UTF-16BE zonder BOM", Buffer.from(`SLEUTEL=${GEHEIM}\r\n`, "utf16le").swap16()],
  ];
  for (const [naam, inhoud] of varianten) {
    it(`${naam}: rood`, () => {
      schrijf("export.csv", inhoud);
      const r = guard();
      expect(r.code, r.uitvoer).not.toBe(0);
      expect(r.uitvoer).toContain("[git] export.csv:1: Supabase secret key");
    });
  }

  it("UTF-16 zonder sleutel: groen", () => {
    schrijf("export.csv", Buffer.from("naam;adres\r\nPiet;Dorpsstraat 1\r\n", "utf16le"));
    const r = guard();
    expect(r.code, r.uitvoer).toBe(0);
  });
});

describe("guard:secrets kijkt ook in bestanden die geen tekst zijn, in public/ en dist/", () => {
  for (const ext of ["pdf", "zip", "woff2", "png", "mp4", "wasm"]) {
    it(`een service role-sleutel in public/bestand.${ext} en dist/bestand.${ext}: rood`, () => {
      schrijf(`public/bestand.${ext}`, binairMet(jwt("service_role")));
      schrijf(`dist/bestand.${ext}`, binairMet(jwt("service_role")));
      const r = guard();
      expect(r.code, r.uitvoer).not.toBe(0);
      expect(r.uitvoer).toContain(`[git] public/bestand.${ext}`);
      expect(r.uitvoer).toContain(`[bundel] dist/bestand.${ext}`);
      expect(r.uitvoer).toContain('rol "service_role"');
    });
  }

  it("elk patroon, ook alleen in dist/ en ook als UTF-16 in een pdf", () => {
    schrijf("dist/assets/lettertype.woff2", binairMet(GEHEIM));
    schrijf("dist/folder.pdf", binairMet(Buffer.from(RESEND, "utf16le")));
    schrijf("dist/data.zip", binairMet(POSTGRES));
    schrijf("dist/anon.png", binairMet(jwt("anon")));
    const r = guard();
    expect(r.code, r.uitvoer).not.toBe(0);
    expect(r.uitvoer).toContain("dist/assets/lettertype.woff2: Supabase secret key");
    expect(r.uitvoer).toContain("dist/folder.pdf: Resend-sleutel");
    expect(r.uitvoer).toContain("dist/data.zip: Postgres-adres met wachtwoord");
    // In een afbeelding hoort zelfs de anon key niet.
    expect(r.uitvoer).toContain('dist/anon.png: JSON Web Token met rol "anon"');
  });

  it("in de bundel telt elk token op een regel, en de markering geldt daar niet", () => {
    schrijf("dist/assets/index.js", `const a="${jwt("anon")}",b="${jwt("service_role")}";\n`);
    schrijf("dist/assets/ander.js", `const s="${GEHEIM}"; // guard-secrets:allow\n`);
    const r = guard();
    expect(r.code, r.uitvoer).not.toBe(0);
    expect(r.uitvoer).toContain('dist/assets/index.js:1: JSON Web Token met rol "service_role"');
    expect(r.uitvoer).toContain("dist/assets/ander.js:1: Supabase secret key");
  });

  it("de afbeeldingen van de template, in public/ en dist/, en de anon key in de bundel: groen", () => {
    const beelden = readdirSync(join(WORTEL, "public")).map((naam) => `public/${naam}`);
    expect(beelden.length).toBeGreaterThan(0);
    for (const pad of beelden) {
      cpSync(join(WORTEL, pad), join(map, pad));
      cpSync(join(WORTEL, pad), join(map, pad.replace(/^public/, "dist")));
    }
    schrijf("dist/assets/index.js", `const anon="${jwt("anon")}";\n`);
    const r = guard();
    expect(r.code, r.uitvoer).toBe(0);
  });

  it("willekeurige bytes (een megabyte) geven geen vals alarm en zijn snel gelezen", () => {
    const ruis = Buffer.alloc(1024 * 1024);
    let x = 12345;
    for (let i = 0; i < ruis.length; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      ruis[i] = x >> 16;
    }
    schrijf("public/video.mp4", ruis);
    schrijf("dist/video.mp4", ruis);
    const begin = Date.now();
    const r = guard();
    expect(r.code, r.uitvoer).toBe(0);
    expect(Date.now() - begin).toBeLessThan(5000);
  });
});
