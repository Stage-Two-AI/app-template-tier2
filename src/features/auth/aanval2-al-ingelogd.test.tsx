import type { Session } from "@supabase/supabase-js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "./use-session";

/**
 * AANVAL ronde 2, doel 5: "Je bent ingelogd als …", /login met een bestaande sessie en de
 * knop voor medewerkers (OpnieuwAlsMedewerker). Een test met GELUKT ALS slaagt als de aanval
 * lukt; een test met MISLUKT legt vast dat de pagina het tegenhoudt.
 */
vi.stubEnv("VITE_INLOGDIENST", "cloudflare,mailcode");

const signInWithOAuth = vi.fn();
const signOut = vi.fn();
const verifyOtp = vi.fn();
const sessie = vi.fn<() => SessionState>();

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      signInWithOAuth,
      signOut,
      signInWithOtp: vi.fn(),
      signInWithPassword: vi.fn(),
      verifyOtp,
    },
  },
}));
vi.mock("./use-session", () => ({ useSession: () => sessie() }));
vi.mock("@/features/items/items-page", () => ({ ItemsPage: () => <p>Startpagina</p> }));

const { default: AppMetDatabase } = await import("./app-met-database");

const KLANT = { user: { email: "piet@klant.nl" } } as Session;

function Adres() {
  const location = useLocation();
  return <output data-testid="adres">{location.pathname + location.search}</output>;
}

function App({ adres }: { adres: string }) {
  return (
    <MemoryRouter initialEntries={[adres]}>
      <AppMetDatabase />
      <Adres />
    </MemoryRouter>
  );
}

beforeEach(() => {
  signInWithOAuth.mockResolvedValue({ data: {}, error: null });
  signOut.mockResolvedValue({ error: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/login");
});

describe("AANVAL 5c: de knop voor medewerkers met een bestaande sessie", () => {
  it("5.6 GELUKT ALS: Cloudflare of Supabase weigert de medewerker, en de pagina zegt 'Je bent ingelogd als …' zonder enige foutmelding", async () => {
    // Een medewerker is per mail binnen (als klant) en klikt op Inloggen voor medewerkers
    // (AlIngelogd of OpnieuwAlsMedewerker): het tabblad onthoudt dat, en gaat naar Cloudflare.
    window.sessionStorage.setItem("inlog-via-dienst", String(Date.now()));
    // Supabase weigert (adres niet bevestigd, geen toegang) en stuurt terug met de fout in het
    // adres. De mailsessie is er nog.
    const terug =
      "/login?error=access_denied&error_code=provider_email_needs_verification&error_description=Unverified+email+with+custom%3Acloudflare.+A+confirmation+email+has+been+sent";
    window.history.replaceState(null, "", terug);
    sessie.mockReturnValue({ session: KLANT, loading: false });
    render(<App adres={terug} />);

    // De app doet alsof het inloggen gelukt is: door naar de app, met de bevestiging erbij.
    expect(await screen.findByText("Startpagina")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("adres").textContent).toBe("/"));
    expect(screen.getByTestId("ingelogd-als")).toHaveTextContent(
      "Je bent ingelogd als piet@klant.nl.",
    );
    // Geen woord over de weigering, en ook niet over "klik op de link in die mail".
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/niet gelukt|bevestigd/)).toBeNull();
  });

  it("5.7 GELUKT ALS: wie op 'Je bent al ingelogd' uitlogt en opnieuw inlogt, blijft op /login hangen zonder 'Je bent ingelogd als …' bovenin", async () => {
    sessie.mockReturnValue({ session: KLANT, loading: false });
    const { rerender } = render(<App adres="/login" />);
    await userEvent.click(await screen.findByRole("button", { name: "Uitloggen" }));
    expect(signOut).toHaveBeenCalledTimes(1);
    sessie.mockReturnValue({ session: null, loading: false });
    rerender(<App adres="/login" />);
    expect(await screen.findByLabelText("E-mailadres")).toBeInTheDocument();

    // Nu logt er iemand anders in (of het slachtoffer via de link van een ander).
    const ANDER = { user: { email: "aanvaller@elders.example" } } as Session;
    sessie.mockReturnValue({ session: ANDER, loading: false });
    rerender(<App adres="/login" />);
    // Niet door naar de app, en de melding van tien seconden bovenin komt niet.
    expect(await screen.findByRole("heading", { name: "Je bent al ingelogd" })).toBeVisible();
    expect(screen.getByTestId("adres").textContent).toBe("/login");
    expect(screen.queryByTestId("ingelogd-als")).toBeNull();
    expect(screen.queryByText("Startpagina")).toBeNull();
  });

  it("5.8 MISLUKT: met een bestaande sessie wisselt een link van een ander het account niet (de link wordt genegeerd)", async () => {
    const link = "/login?token_hash=pkce_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&type=email";
    window.history.replaceState(null, "", link);
    sessie.mockReturnValue({ session: KLANT, loading: false });
    render(<App adres={link} />);
    expect(await screen.findByRole("heading", { name: "Je bent al ingelogd" })).toBeVisible();
    expect(screen.getByText("piet@klant.nl")).toBeVisible();
    expect(verifyOtp).not.toHaveBeenCalled();
    // Wel: de link blijft in de adresbalk staan (en dus in de geschiedenis van de browser).
    expect(window.location.search).toContain("token_hash=");
  });
});

describe("AANVAL 5b: 'Je bent ingelogd als …'", () => {
  it("5.9 GELUKT ALS: de melding toont alleen het adres van het account; een adres van de aanvaller dat op dat van het slachtoffer lijkt, staat er zonder enige nadruk", async () => {
    window.sessionStorage.setItem("inlog-via-dienst", String(Date.now()));
    const LIJKT = { user: { email: "piet@klant.nl.inloggen-portaal.example" } } as Session;
    sessie.mockReturnValue({ session: LIJKT, loading: false });
    render(<App adres="/login" />);
    const melding = await screen.findByTestId("ingelogd-als");
    expect(melding).toHaveTextContent(
      "Je bent ingelogd als piet@klant.nl.inloggen-portaal.example.",
    );
    // Niets vergelijkt dit adres met het adres dat het slachtoffer zelf invulde.
    expect(melding).not.toHaveTextContent(/let op|ander/i);
  });
});
