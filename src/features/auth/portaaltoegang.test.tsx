import type { Session } from "@supabase/supabase-js";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

type Antwoord = { data: unknown; error: { message: string } | null };
const antwoorden = new Map<string, Antwoord>();
const rpc = vi.fn(async (naam: string): Promise<Antwoord> => {
  return antwoorden.get(naam) ?? { data: null, error: null };
});

vi.mock("@/lib/supabase", () => ({
  supabase: { rpc, auth: { signOut: vi.fn(), signInWithOAuth: vi.fn() } },
}));

const { bepaalToegang, Portaaltoegang } = await import("./portaaltoegang");

/** Een sessie met een token zoals Supabase het maakt; alleen `amr` en het adres doen mee. */
function sessie(methode: "oauth" | "otp"): Session {
  const inhoud = Buffer.from(JSON.stringify({ amr: [{ method: methode, timestamp: 1 }] })).toString(
    "base64url",
  );
  return {
    access_token: `kop.${inhoud}.handtekening`,
    user: { email: "iemand@voorbeeld.nl" },
  } as Session;
}

function zeg(o: { medewerker?: boolean; klant?: boolean; fout?: string }) {
  const fout = o.fout ? { message: o.fout } : null;
  antwoorden.set("is_medewerker", { data: o.medewerker ?? false, error: fout });
  antwoorden.set("klant_aanmelden", { data: null, error: null });
  antwoorden.set("is_goedgekeurde_klant", { data: o.klant ?? false, error: null });
}

const aangeroepen = () => rpc.mock.calls.map(([naam]) => naam);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  antwoorden.clear();
});

describe("bepaalToegang: wat de database over deze sessie zegt", () => {
  it("een medewerker meldt zich nooit aan als klant", async () => {
    zeg({ medewerker: true });
    expect(await bepaalToegang(sessie("oauth"))).toBe("medewerker");
    expect(aangeroepen()).toEqual(["is_medewerker"]);
  });

  it("via Cloudflare binnen maar de twaalf uur zijn om: verlopen, niet op de wachtlijst", async () => {
    zeg({ medewerker: false });
    expect(await bepaalToegang(sessie("oauth"))).toBe("verlopen");
    expect(aangeroepen()).not.toContain("klant_aanmelden");
  });

  it("per mail: aanmelden als klant, dan wachten of verder", async () => {
    zeg({ klant: false });
    expect(await bepaalToegang(sessie("otp"))).toBe("wacht");
    expect(aangeroepen()).toEqual(["is_medewerker", "klant_aanmelden", "is_goedgekeurde_klant"]);
    zeg({ klant: true });
    expect(await bepaalToegang(sessie("otp"))).toBe("klant");
  });

  it("een storing is een storing, geen toegang", async () => {
    zeg({ fout: "geen verbinding" });
    expect(await bepaalToegang(sessie("otp"))).toBe("fout");
  });
});

describe("Portaaltoegang", () => {
  it("toont de app aan een goedgekeurde klant", async () => {
    zeg({ klant: true });
    render(
      <Portaaltoegang session={sessie("otp")}>
        <p>De app</p>
      </Portaaltoegang>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Bezig met laden");
    expect(await screen.findByText("De app")).toBeInTheDocument();
  });

  it("toont het wachtscherm, en de app zodra een medewerker heeft goedgekeurd", async () => {
    zeg({ klant: false });
    render(
      <Portaaltoegang session={sessie("otp")}>
        <p>De app</p>
      </Portaaltoegang>,
    );
    expect(
      await screen.findByRole("heading", { name: "Je account wacht op goedkeuring" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("De app")).toBeNull();
    zeg({ klant: true });
    await userEvent.click(screen.getByRole("button", { name: "Opnieuw kijken" }));
    expect(await screen.findByText("De app")).toBeInTheDocument();
  });

  it("vraagt een medewerker wiens twaalf uur om zijn opnieuw in te loggen", async () => {
    zeg({ medewerker: false });
    render(
      <Portaaltoegang session={sessie("oauth")}>
        <p>De app</p>
      </Portaaltoegang>,
    );
    expect(await screen.findByText("Log opnieuw in als medewerker")).toBeInTheDocument();
    expect(screen.queryByText("De app")).toBeNull();
  });

  it("zegt het bij een storing, en toont de app dan niet", async () => {
    zeg({ fout: "geen verbinding" });
    render(
      <Portaaltoegang session={sessie("otp")}>
        <p>De app</p>
      </Portaaltoegang>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Het lukte niet");
    expect(screen.queryByText("De app")).toBeNull();
  });
});
