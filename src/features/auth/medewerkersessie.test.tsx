import type { Session } from "@supabase/supabase-js";
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const signInWithOAuth = vi.fn();

vi.mock("@/lib/supabase", () => ({
  supabase: { rpc, auth: { signInWithOAuth, signInWithOtp: vi.fn() } },
}));

const { begonViaDienst, OpnieuwAlsMedewerker, OPNIEUW_KIJKEN_MS, standVan, useMedewerkersessie } =
  await import("./medewerkersessie");

/** Een sessie met een token zoals Supabase het maakt; alleen de inhoud doet hier mee. */
function sessie(methode: string): Session {
  const inhoud = Buffer.from(JSON.stringify({ amr: [{ method: methode, timestamp: 1 }] })).toString(
    "base64url",
  );
  return { access_token: `kop.${inhoud}.handtekening` } as Session;
}

beforeEach(() => {
  signInWithOAuth.mockResolvedValue({ data: {}, error: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  window.sessionStorage.clear();
});

describe("standVan: wat een scherm voor medewerkers moet tonen", () => {
  it("leest uit het token hoe de sessie begon", () => {
    expect(begonViaDienst(sessie("oauth"))).toBe(true);
    expect(begonViaDienst(sessie("otp"))).toBe(false);
    expect(begonViaDienst({ access_token: "geen-token" })).toBe(false);
    expect(begonViaDienst(null)).toBe(false);
  });

  it("volgt de database, en zegt 'verlopen' als een sessie via Cloudflare geen rechten meer heeft", () => {
    expect(standVan(null, null)).toBe("geen");
    expect(standVan(sessie("oauth"), null)).toBe("laden");
    expect(standVan(sessie("oauth"), true)).toBe("medewerker");
    // Na twaalf uur: nog ingelogd, maar de database zegt nee.
    expect(standVan(sessie("oauth"), false)).toBe("verlopen");
    // Per mail was iemand nooit medewerker: dan valt er niets te verlopen.
    expect(standVan(sessie("otp"), false)).toBe("geen");
    // De pagina maakt niemand medewerker: het token alleen is niet genoeg.
    expect(standVan(sessie("oauth"), false)).not.toBe("medewerker");
  });
});

describe("useMedewerkersessie", () => {
  it("vraagt het aan de database en kijkt later opnieuw", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    rpc.mockResolvedValue({ data: true, error: null });
    const { result } = renderHook(() => useMedewerkersessie(sessie("oauth")));
    expect(result.current).toBe("laden");
    await waitFor(() => expect(result.current).toBe("medewerker"));
    expect(rpc).toHaveBeenCalledWith("is_medewerker");

    // De twaalf uur gaan voorbij terwijl het scherm open staat.
    rpc.mockResolvedValue({ data: false, error: null });
    await vi.advanceTimersByTimeAsync(OPNIEUW_KIJKEN_MS + 1000);
    await waitFor(() => expect(result.current).toBe("verlopen"));
  });

  it("vraagt niets zonder sessie", () => {
    const { result } = renderHook(() => useMedewerkersessie(null));
    expect(result.current).toBe("geen");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("OpnieuwAlsMedewerker", () => {
  it("zegt wat er aan de hand is en logt opnieuw in via Cloudflare, zonder eerst uit te loggen", async () => {
    render(<OpnieuwAlsMedewerker />);
    const melding = screen.getByRole("alert");
    expect(melding).toHaveTextContent("Log opnieuw in als medewerker");
    expect(melding).toHaveTextContent("Je inlog als medewerker is verlopen");
    await userEvent.click(screen.getByRole("button", { name: "Inloggen voor medewerkers" }));
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: "custom:cloudflare",
      options: { redirectTo: `${window.location.origin}/login` },
    });
    // Het tabblad onthoudt dat het zelf naar Cloudflare ging (zie de route /login).
    expect(window.sessionStorage.getItem("inlog-via-dienst")).not.toBeNull();
  });

  it("zegt het als doorsturen mislukt", async () => {
    signInWithOAuth.mockResolvedValue({ data: {}, error: { message: "boem" } });
    render(<OpnieuwAlsMedewerker />);
    await userEvent.click(screen.getByRole("button", { name: "Inloggen voor medewerkers" }));
    expect(await screen.findByText(/Inloggen is niet gelukt/)).toBeInTheDocument();
  });
});
