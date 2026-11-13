import type { Session } from "@supabase/supabase-js";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "./use-session";

/**
 * De route /login bij een klantportaal (`VITE_INLOGDIENST=cloudflare,mailcode`): na het
 * inloggen door naar de app met kort de melding op welk adres je binnen bent, en voor wie al
 * was ingelogd de knop voor medewerkers. Eén dienst blijft als vanouds: zie
 * app-met-database.test.tsx.
 */
vi.stubEnv("VITE_INLOGDIENST", "cloudflare,mailcode");

const signInWithOAuth = vi.fn();
const signOut = vi.fn();
const sessie = vi.fn<() => SessionState>();

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      signInWithOAuth,
      signOut,
      signInWithOtp: vi.fn(),
      signInWithPassword: vi.fn(),
      verifyOtp: vi.fn(),
    },
  },
}));
vi.mock("./use-session", () => ({ useSession: () => sessie() }));
vi.mock("@/features/items/items-page", () => ({ ItemsPage: () => <p>Startpagina</p> }));

const { default: AppMetDatabase, INGELOGD_ALS_MS } = await import("./app-met-database");

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
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/login");
});

describe("klantportaal: net ingelogd", () => {
  it("gaat na het inloggen naar de app en zegt kort op welk adres je bent ingelogd", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sessie.mockReturnValue({ session: null, loading: false });
    const { rerender } = render(<App adres="/login" />);
    expect(screen.getByRole("button", { name: "Inloggen voor medewerkers" })).toBeInTheDocument();
    window.sessionStorage.setItem(
      "inlogcode",
      JSON.stringify({ email: "piet@klant.nl", verstuurdOp: Date.now() }),
    );

    // De code klopte: Supabase meldt de sessie.
    sessie.mockReturnValue({ session: KLANT, loading: false });
    rerender(<App adres="/login" />);
    expect(await screen.findByText("Startpagina")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("adres").textContent).toBe("/"));
    expect(screen.getByTestId("ingelogd-als")).toHaveTextContent(
      "Je bent ingelogd als piet@klant.nl.",
    );
    // Het tabblad onthoudt het adres niet langer.
    expect(window.sessionStorage.length).toBe(0);

    // Kort: daarna is de melding weer weg.
    await act(() => vi.advanceTimersByTimeAsync(INGELOGD_ALS_MS + 100));
    expect(screen.queryByTestId("ingelogd-als")).toBeNull();
    expect(screen.getByText("Startpagina")).toBeInTheDocument();
  });

  it("gaat ook door naar de app als dit tabblad net terugkomt van Cloudflare", async () => {
    // Supabase heeft de sessie dan al voordat de pagina tekent.
    window.sessionStorage.setItem("inlog-via-dienst", String(Date.now()));
    sessie.mockReturnValue({ session: KLANT, loading: false });
    render(<App adres="/login" />);
    expect(await screen.findByText("Startpagina")).toBeInTheDocument();
    expect(screen.getByTestId("ingelogd-als")).toHaveTextContent("piet@klant.nl");
    expect(window.sessionStorage.getItem("inlog-via-dienst")).toBeNull();
  });

  it("toont de melding niet aan wie al ingelogd de app opent", async () => {
    sessie.mockReturnValue({ session: KLANT, loading: false });
    render(<App adres="/" />);
    expect(await screen.findByText("Startpagina")).toBeInTheDocument();
    expect(screen.queryByTestId("ingelogd-als")).toBeNull();
  });
});

describe("klantportaal: al ingelogd en toch naar /login", () => {
  it("biedt de knop voor medewerkers aan in plaats van terug te sturen", async () => {
    // Een medewerker die per mail binnen is, of wiens twaalf uur om zijn, hoeft niet eerst
    // uit te loggen om bij de knop te komen.
    sessie.mockReturnValue({ session: KLANT, loading: false });
    render(<App adres="/login" />);
    expect(screen.getByRole("heading", { name: "Je bent al ingelogd" })).toBeInTheDocument();
    expect(screen.getByText("piet@klant.nl")).toBeInTheDocument();
    expect(screen.getByTestId("adres")).toHaveTextContent("/login");
    expect(screen.queryByText("Startpagina")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Inloggen voor medewerkers" }));
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: "custom:cloudflare",
      options: { redirectTo: `${window.location.origin}/login` },
    });
    expect(window.sessionStorage.getItem("inlog-via-dienst")).not.toBeNull();
  });

  it("laat wie dat niet wil gewoon verder gaan, of uitloggen", async () => {
    sessie.mockReturnValue({ session: KLANT, loading: false });
    render(<App adres="/login" />);
    await userEvent.click(screen.getByRole("button", { name: "Uitloggen" }));
    expect(signOut).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("link", { name: "Verder naar de app" }));
    expect(await screen.findByText("Startpagina")).toBeInTheDocument();
    // Zelf doorgeklikt is niet "net ingelogd".
    expect(screen.queryByTestId("ingelogd-als")).toBeNull();
  });

  it("zegt het als doorsturen naar Cloudflare mislukt", async () => {
    signInWithOAuth.mockResolvedValue({ data: {}, error: { message: "boem" } });
    sessie.mockReturnValue({ session: KLANT, loading: false });
    render(<App adres="/login" />);
    await userEvent.click(screen.getByRole("button", { name: "Inloggen voor medewerkers" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Inloggen is niet gelukt");
  });
});
