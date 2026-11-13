import type { Session } from "@supabase/supabase-js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "./use-session";

/**
 * De hele keten tegen de eindeloze inloglus: Supabase stuurt terug naar /login, de
 * route /login toont zonder sessie de inlogpagina (zonder doorverwijzing die ?error=
 * uit het adres haalt), en de inlogpagina stuurt bij een fout niet opnieuw door.
 */

vi.stubEnv("VITE_INLOGDIENST", "cloudflare");

const signInWithOAuth = vi.fn();
const sessie = vi.fn<() => SessionState>();

vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { signInWithOAuth, signInWithOtp: vi.fn(), signInWithPassword: vi.fn() } },
}));
vi.mock("./use-session", () => ({ useSession: () => sessie() }));
vi.mock("@/features/items/items-page", () => ({ ItemsPage: () => <p>Startpagina</p> }));

const { default: AppMetDatabase } = await import("./app-met-database");

function Adres() {
  const location = useLocation();
  return <output data-testid="adres">{location.pathname + location.search}</output>;
}

/** Router en window.location op hetzelfde adres, zoals BrowserRouter in de echte app. */
function renderOp(adres: string) {
  window.history.replaceState(null, "", adres);
  render(
    <MemoryRouter initialEntries={[adres]}>
      <AppMetDatabase />
      <Adres />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  signInWithOAuth.mockResolvedValue({ data: {}, error: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/login");
});

describe("AppMetDatabase op /login", () => {
  it("toont zonder sessie de fout van Supabase en stuurt niet opnieuw door", async () => {
    sessie.mockReturnValue({ session: null, loading: false });
    renderOp("/login?error=access_denied");
    expect(await screen.findByRole("alert")).toHaveTextContent("Inloggen is niet gelukt");
    expect(screen.getByTestId("adres")).toHaveTextContent("/login?error=access_denied");
    expect(signInWithOAuth).not.toHaveBeenCalled();
  });

  it("gaat met sessie naar de startpagina", async () => {
    sessie.mockReturnValue({ session: {} as Session, loading: false });
    renderOp("/login");
    expect(await screen.findByText("Startpagina")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("adres").textContent).toBe("/"));
    expect(signInWithOAuth).not.toHaveBeenCalled();
    // Eén dienst blijft als vanouds: geen tussenpagina en geen melding bovenin.
    expect(screen.queryByText(/Je bent/)).toBeNull();
  });
});
