import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../../src/lib/database.types";

/** Hulp voor de aanvalstests (tests/rls/aanval-*.test.ts). Alleen tegen de lokale Supabase. */
export const url = String(import.meta.env.SUPABASE_URL);
export const anonKey = String(import.meta.env.SUPABASE_ANON_KEY);
const mailUrl = String(import.meta.env.SUPABASE_MAIL_URL || "http://127.0.0.1:54324").replace(/\/$/, "");
if (!/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(mailUrl)) {
  throw new Error("SUPABASE_MAIL_URL wijst niet naar de lokale mailvanger.");
}

export function nieuweClient(): SupabaseClient<Database> {
  return createClient<Database>(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export const wacht = (ms: number) => new Promise((klaar) => setTimeout(klaar, ms));

async function ids(email: string): Promise<string[]> {
  const antwoord = await fetch(`${mailUrl}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
  const gevonden = (await antwoord.json()) as { messages?: { ID: string }[] };
  return (gevonden.messages ?? []).map((mail) => mail.ID);
}

/** Als wachtOpInlogmail, maar geeft de hele HTML van de eerstvolgende mail (elk sjabloon). */
export async function wachtOpMailHtml(email: string): Promise<(wachtMs?: number) => Promise<string | null>> {
  const eerder = new Set(await ids(email));
  return async (wachtMs = 10_000) => {
    const tot = Date.now() + wachtMs;
    while (Date.now() < tot) {
      const nieuw = (await ids(email)).find((id) => !eerder.has(id));
      if (nieuw) {
        eerder.add(nieuw);
        const bericht = (await (await fetch(`${mailUrl}/api/v1/message/${nieuw}`)).json()) as { HTML?: string };
        return bericht.HTML ?? "";
      }
      await wacht(250);
    }
    return null;
  };
}

export function linksUit(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((treffer) => (treffer[1] ?? "").replaceAll("&amp;", "&"));
}

export function codeUit(html: string): string | null {
  return /id="code"[^>]*>\s*(\d{8})\s*</.exec(html)?.[1] ?? null;
}

/** Een code aanvragen, met één herhaling als Supabase "te snel" zegt. */
export async function vraagCodeAan(
  client: SupabaseClient<Database>,
  email: string,
  opties: { emailRedirectTo?: string; shouldCreateUser?: boolean } = {},
) {
  let aanvraag = await client.auth.signInWithOtp({ email, options: opties });
  if (aanvraag.error?.status === 429) {
    await wacht(1500);
    aanvraag = await client.auth.signInWithOtp({ email, options: opties });
  }
  return aanvraag;
}
