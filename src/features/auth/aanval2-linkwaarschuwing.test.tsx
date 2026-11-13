import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AANVAL ronde 2, doel 5: de waarschuwing "Heb je deze mail zelf aangevraagd?" bij een link
 * uit de mail. Elke test hier SLAAGT als de aanval lukt.
 *
 * De pagina onthoudt in localStorage alleen een tijdstip ("deze browser vroeg een code aan",
 * een kwartier geldig), zonder adres en zonder iets van de link. Daardoor:
 *   - telt elke aanvraag, voor welk adres ook, als bewijs dat de link van de aanvaller "hier
 *     is aangevraagd";
 *   - kan de aanvaller het slachtoffer met een eigen link naar de echte pagina zelf een
 *     aanvraag laten doen;
 *   - ziet een echte klant de waarschuwing juist wel in gewone gevallen (alleen mailcode,
 *     geen opslag), zodat hij went aan doorklikken.
 */
const signInWithOAuth = vi.fn();
const signInWithOtp = vi.fn();
const signInWithPassword = vi.fn();
const verifyOtp = vi.fn();

vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { signInWithOAuth, signInWithOtp, signInWithPassword, verifyOtp } },
}));

const { LoginPage } = await import("./login-page");

const KLANTPORTAAL = ["cloudflare", "mailcode"] as const;
/** De link uit de mail van de aanvaller: zijn eigen account. */
const LINK_VAN_AANVALLER = "/login?token_hash=pkce_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&type=email";

beforeEach(() => {
  signInWithOAuth.mockResolvedValue({ data: {}, error: null });
  signInWithOtp.mockResolvedValue({ data: {}, error: null });
  verifyOtp.mockResolvedValue({ data: {}, error: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/login");
});

describe("AANVAL 5a: de waarschuwing omzeilen", () => {
  it("5.1 GELUKT ALS: de aanvaller laat het slachtoffer met een eigen link zelf een code aanvragen; daarna opent zijn link zonder waarschuwing", async () => {
    // Mail 1 van de aanvaller: een link naar de echte inlogpagina die "verlopen" zegt. De
    // aanvaller kiest die melding met het adres; de pagina vraagt zelf om een nieuwe aanvraag.
    window.history.replaceState(null, "", "/login?error_code=otp_expired");
    render(<LoginPage dienst={KLANTPORTAAL} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Deze link is verlopen of al gebruikt. Vraag hieronder een nieuwe code aan.",
    );
    await userEvent.type(screen.getByLabelText("E-mailadres"), "slachtoffer@klant.nl");
    await userEvent.click(screen.getByRole("button", { name: "Doorgaan" }));
    await screen.findByLabelText("Code van acht cijfers");
    cleanup();

    // Mail 2 van de aanvaller (de link uit zíjn inlogmail), in een nieuw tabblad.
    window.sessionStorage.clear();
    window.history.replaceState(null, "", LINK_VAN_AANVALLER);
    render(<LoginPage dienst={KLANTPORTAAL} />);
    expect(screen.queryByTestId("link-waarschuwing")).toBeNull();
    expect(screen.getByText("Je bent er bijna. Klik op de knop om in te loggen.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Inloggen" }));
    // Het slachtoffer logt in op het account van de aanvaller, met de link van de aanvaller.
    expect(verifyOtp).toHaveBeenCalledWith({
      token_hash: "pkce_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      type: "email",
    });
  });

  it("5.2 GELUKT ALS: ook een aanvraag die Supabase weigerde (geen mail verstuurd) en daarna 'Ander e-mailadres' laten het kenmerk staan", async () => {
    signInWithOtp.mockResolvedValue({
      data: {},
      error: { message: "Signups not allowed for otp", status: 422, code: "otp_disabled" },
    });
    render(<LoginPage dienst={KLANTPORTAAL} />);
    await userEvent.type(screen.getByLabelText("E-mailadres"), "bestaat-niet@klant.nl");
    await userEvent.click(screen.getByRole("button", { name: "Doorgaan" }));
    await screen.findByLabelText("Code van acht cijfers");
    await userEvent.click(screen.getByRole("button", { name: "Ander e-mailadres" }));
    cleanup();

    window.sessionStorage.clear();
    window.history.replaceState(null, "", LINK_VAN_AANVALLER);
    render(<LoginPage dienst={KLANTPORTAAL} />);
    // Er is in deze browser nooit een mail aangevraagd die aankwam, en toch geen waarschuwing.
    expect(screen.queryByTestId("link-waarschuwing")).toBeNull();
  });

  it("5.3 GELUKT ALS: het kenmerk hangt niet aan het adres: wat er bewaard wordt is alleen een tijdstip", async () => {
    render(<LoginPage dienst={KLANTPORTAAL} />);
    await userEvent.type(screen.getByLabelText("E-mailadres"), "slachtoffer@klant.nl");
    await userEvent.click(screen.getByRole("button", { name: "Doorgaan" }));
    await screen.findByLabelText("Code van acht cijfers");
    const bewaard = Object.fromEntries(
      Array.from({ length: window.localStorage.length }, (_, i) => {
        const sleutel = window.localStorage.key(i) ?? "";
        return [sleutel, window.localStorage.getItem(sleutel)];
      }),
    );
    expect(Object.keys(bewaard)).toEqual(["inlogcode-aangevraagd"]);
    expect(bewaard["inlogcode-aangevraagd"]).toMatch(/^\d+$/);
  });
});

describe("AANVAL 5a: de waarschuwing altijd laten tonen, zodat niemand hem meer leest", () => {
  it("5.4 GELUKT ALS: met alleen mailcode (VITE_INLOGDIENST=mailcode) krijgt elke klant de waarschuwing, ook bij zijn eigen link in dezelfde browser", async () => {
    render(<LoginPage dienst="mailcode" />);
    await userEvent.type(screen.getByLabelText("E-mailadres"), "piet@klant.nl");
    await userEvent.click(screen.getByRole("button", { name: "Stuur inloglink" }));
    await screen.findByText("Kijk in je mail: daar staat een link om in te loggen.");
    expect(signInWithOtp).toHaveBeenCalledTimes(1);
    cleanup();

    // Dezelfde browser, de eigen link, direct daarna.
    window.history.replaceState(
      null,
      "",
      "/login?token_hash=pkce_0123456789abcdef0123456789abcdef&type=email",
    );
    render(<LoginPage dienst="mailcode" />);
    expect(screen.getByTestId("link-waarschuwing")).toHaveTextContent(
      "Heb je deze mail zelf aangevraagd?",
    );
  });

  it("5.5 GELUKT ALS: zonder werkende opslag (geblokkeerd of vol) krijgt een klant de waarschuwing bij zijn eigen link", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    render(<LoginPage dienst={KLANTPORTAAL} />);
    await userEvent.type(screen.getByLabelText("E-mailadres"), "piet@klant.nl");
    await userEvent.click(screen.getByRole("button", { name: "Doorgaan" }));
    await screen.findByLabelText("Code van acht cijfers");
    cleanup();

    window.history.replaceState(
      null,
      "",
      "/login?token_hash=pkce_0123456789abcdef0123456789abcdef&type=email",
    );
    render(<LoginPage dienst={KLANTPORTAAL} />);
    expect(screen.getByTestId("link-waarschuwing")).toBeInTheDocument();
    // En de waarschuwing vraagt niets extra's: dezelfde ene knop als zonder waarschuwing.
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Inloggen" })).toBeEnabled();
  });
});
