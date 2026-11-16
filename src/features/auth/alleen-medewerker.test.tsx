import type { Session } from "@supabase/supabase-js";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();

vi.mock("@/lib/supabase", () => ({
  supabase: { rpc, auth: { signInWithOAuth: vi.fn() } },
}));

const { AlleenMedewerker } = await import("./alleen-medewerker");

function sessie(methode: "oauth" | "otp"): Session {
  const inhoud = Buffer.from(JSON.stringify({ amr: [{ method: methode, timestamp: 1 }] })).toString(
    "base64url",
  );
  return { access_token: `kop.${inhoud}.handtekening` } as Session;
}

function toon(s: Session | null) {
  render(
    <AlleenMedewerker session={s}>
      <p>Alleen voor medewerkers</p>
    </AlleenMedewerker>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AlleenMedewerker", () => {
  it("toont de inhoud bij een verse medewerkersessie", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    toon(sessie("oauth"));
    expect(await screen.findByText("Alleen voor medewerkers")).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith("is_medewerker");
  });

  it("vraagt opnieuw in te loggen als de twaalf uur om zijn", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    toon(sessie("oauth"));
    expect(await screen.findByText("Log opnieuw in als medewerker")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Inloggen voor medewerkers" })).toBeInTheDocument();
    expect(screen.queryByText("Alleen voor medewerkers")).toBeNull();
  });

  it("zegt 'Geen toegang' tegen een klant, ook op het adres van een medewerker", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    toon(sessie("otp"));
    expect(await screen.findByText("Geen toegang")).toBeInTheDocument();
    expect(screen.queryByText("Alleen voor medewerkers")).toBeNull();
  });

  it("toont zonder sessie niets van de inhoud", () => {
    toon(null);
    expect(screen.getByText("Geen toegang")).toBeInTheDocument();
    expect(rpc).not.toHaveBeenCalled();
  });
});
