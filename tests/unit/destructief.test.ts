import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const LIB = resolve(__dirname, "../../scripts/lib/destructief.mjs");

function regels(sql: string): string[] {
  const code = `import(${JSON.stringify(pathToFileURL(LIB).href)}).then((m) => process.stdout.write(JSON.stringify(m.destructieveRegels(process.argv.at(-1)))))`;
  return JSON.parse(
    execFileSync("node", ["--input-type=module", "-e", code, "--", sql], { encoding: "utf8" }),
  );
}

describe("destructieve migraties herkennen", () => {
  it("ziet drop table en drop column", () => {
    expect(regels("alter table plant drop column kleur; drop table oud;")).toEqual([
      "drop table",
      "drop column",
    ]);
  });

  it("negeert commentaar", () => {
    expect(regels("-- drop table plant\nselect 1;")).toEqual([]);
  });

  it("vindt drop policy op een bestaande tabel gevaarlijk", () => {
    expect(regels('drop policy "lezen" on plant;')).toEqual(["drop policy"]);
  });

  it("laat drop policy if exists door op een tabel uit dezelfde migratie", () => {
    const sql = [
      "create table if not exists public.week (id bigint primary key);",
      "alter table public.week enable row level security;",
      'drop policy if exists "lezen" on public.week;',
      'create policy "lezen" on public.week for select using (true);',
    ].join("\n");
    expect(regels(sql)).toEqual([]);
  });

  it("laat drop en create van dezelfde policy op een bestaande tabel door", () => {
    const sql = [
      'drop policy if exists "lezen" on plant;',
      'create policy "lezen" on plant for select using (auth.uid() = eigenaar);',
    ].join("\n");
    expect(regels(sql)).toEqual([]);
  });

  it("blijft streng als de nieuwe policy een andere naam heeft", () => {
    const sql = [
      'drop policy if exists "lezen" on plant;',
      'create policy "iedereen" on plant for select using (true);',
    ].join("\n");
    expect(regels(sql)).toEqual(["drop policy"]);
  });
});
