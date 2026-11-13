import type { Session } from "@supabase/supabase-js";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Klant = { user_id: string; e_mail: string; goedgekeurd: boolean; aangemeld_op: string };

let klanten: Klant[] = [];
/** Wat de database doet met een wijziging: true = toegestaan, false = RLS weigert (lege lijst). */
let wijzigenMag = true;
const wijzigingen: Array<{ waarden: Partial<Klant>; kolom: string; waarde: string }> = [];

const rpc = vi.fn();
const from = vi.fn((tabel: string) => {
  if (tabel !== "klanten") throw new Error(`onverwachte tabel ${tabel}`);
  return {
    select: () => ({
      order: async () => ({ data: klanten.map((k) => ({ ...k })), error: null }),
    }),
    update: (waarden: Partial<Klant>) => ({
      eq: (kolom: string, waarde: string) => ({
        select: async () => {
          wijzigingen.push({ waarden, kolom, waarde });
          if (!wijzigenMag) return { data: [], error: null };
          klanten = klanten.map((k) => (k.user_id === waarde ? { ...k, ...waarden } : k));
          return { data: [{ user_id: waarde }], error: null };
        },
      }),
    }),
  };
});

vi.mock("@/lib/supabase", () => ({
  supabase: { rpc, from, auth: { signInWithOAuth: vi.fn() } },
}));

const { KlantenGoedkeurenPage } = await import("./klanten-goedkeuren");

function sessie(methode: "oauth" | "otp"): Session {
  const inhoud = Buffer.from(JSON.stringify({ amr: [{ method: methode, timestamp: 1 }] })).toString(
    "base64url",
  );
  return { access_token: `kop.${inhoud}.handtekening` } as Session;
}

beforeEach(() => {
  klanten = [
    {
      user_id: "u-1",
      e_mail: "nieuw@klant.nl",
      goedgekeurd: false,
      aangemeld_op: "2026-11-12T09:00:00Z",
    },
    {
      user_id: "u-2",
      e_mail: "vast@klant.nl",
      goedgekeurd: true,
      aangemeld_op: "2026-11-01T09:00:00Z",
    },
  ];
  wijzigenMag = true;
  wijzigingen.length = 0;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const regel = (adres: string) => {
  const li = screen.getByText(adres).closest("li");
  if (!li) throw new Error(`geen regel voor ${adres}`);
  return within(li);
};

describe("KlantenGoedkeurenPage", () => {
  it("een medewerker ziet de lijst en keurt goed en trekt in", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    render(<KlantenGoedkeurenPage session={sessie("oauth")} />);
    expect(screen.getByRole("heading", { name: "Klanten goedkeuren" })).toBeInTheDocument();
    expect(await screen.findByText("nieuw@klant.nl")).toBeInTheDocument();
    expect(regel("nieuw@klant.nl").getByText(/Wacht op goedkeuring/)).toBeInTheDocument();

    await userEvent.click(regel("nieuw@klant.nl").getByRole("button", { name: "Goedkeuren" }));
    expect(wijzigingen).toEqual([
      { waarden: { goedgekeurd: true }, kolom: "user_id", waarde: "u-1" },
    ]);
    expect(await regel("nieuw@klant.nl").findByRole("button", { name: "Intrekken" })).toBeVisible();

    await userEvent.click(regel("vast@klant.nl").getByRole("button", { name: "Intrekken" }));
    expect(wijzigingen.at(-1)).toEqual({
      waarden: { goedgekeurd: false },
      kolom: "user_id",
      waarde: "u-2",
    });
    expect(await regel("vast@klant.nl").findByRole("button", { name: "Goedkeuren" })).toBeVisible();
  });

  it("zegt het als de database de wijziging weigert", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    wijzigenMag = false;
    render(<KlantenGoedkeurenPage session={sessie("oauth")} />);
    await screen.findByText("nieuw@klant.nl");
    await userEvent.click(regel("nieuw@klant.nl").getByRole("button", { name: "Goedkeuren" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Het lukte niet om nieuw@klant.nl te wijzigen",
    );
    expect(regel("nieuw@klant.nl").getByRole("button", { name: "Goedkeuren" })).toBeVisible();
  });

  it("een klant ziet geen lijst, en het scherm vraagt de tabel niet eens op", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    render(<KlantenGoedkeurenPage session={sessie("otp")} />);
    expect(await screen.findByText("Geen toegang")).toBeInTheDocument();
    expect(screen.queryByText("nieuw@klant.nl")).toBeNull();
    expect(from).not.toHaveBeenCalled();
  });
});
