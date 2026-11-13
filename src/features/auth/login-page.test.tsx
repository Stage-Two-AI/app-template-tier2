import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const signInWithOAuth = vi.fn();
const signInWithOtp = vi.fn();
const signInWithPassword = vi.fn();
const verifyOtp = vi.fn();

vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { signInWithOAuth, signInWithOtp, signInWithPassword, verifyOtp } },
}));

const { LoginPage } = await import("./login-page");

beforeEach(() => {
  signInWithOAuth.mockResolvedValue({ data: {}, error: null });
  signInWithOtp.mockResolvedValue({ data: {}, error: null });
  signInWithPassword.mockResolvedValue({ data: {}, error: null });
  verifyOtp.mockResolvedValue({ data: {}, error: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/login");
  for (const script of document.head.querySelectorAll("script")) script.remove();
});

describe("LoginPage met cloudflare", () => {
  it("stuurt meteen door, zonder knop, precies één keer", async () => {
    render(<LoginPage dienst="cloudflare" />);
    await waitFor(() => expect(signInWithOAuth).toHaveBeenCalledTimes(1));
    expect(signInWithOAuth.mock.calls[0]?.[0].provider).toBe("custom:cloudflare");
    expect(screen.getByRole("status")).toHaveTextContent("doorgestuurd");
  });

  it("stuurt niet opnieuw door als Supabase met een fout terugkomt", async () => {
    window.history.replaceState(
      null,
      "",
      "/login?error=access_denied&error_description=geen+toegang",
    );
    render(<LoginPage dienst="cloudflare" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Inloggen is niet gelukt. Probeer het opnieuw of vraag je beheerder om toegang.",
    );
    expect(signInWithOAuth).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Opnieuw proberen" })).toBeInTheDocument();
  });

  it("toont een vaste tekst, nooit de tekst uit het adres", async () => {
    // Anders zet iedereen met een link eigen tekst op het echte inlogscherm.
    const vanEenAnder = encodeURIComponent("Uw account is geblokkeerd. Bel 0900-1234.");
    window.history.replaceState(
      null,
      "",
      `/login?error=${vanEenAnder}&error_description=${vanEenAnder}#error_description=${vanEenAnder}`,
    );
    render(<LoginPage dienst="cloudflare" />);
    const melding = await screen.findByRole("alert");
    expect(melding).toHaveTextContent("Inloggen is niet gelukt");
    expect(document.body).not.toHaveTextContent(/0900|geblokkeerd/);
  });

  it("legt een nieuwe medewerker uit wat te doen, alleen als dit tabblad zelf naar Cloudflare ging", async () => {
    const onbevestigd =
      "/login?error=access_denied&error_code=provider_email_needs_verification&error_description=Unverified+email+with+custom%3Acloudflare.+A+confirmation+email+has+been+sent";
    window.history.replaceState(null, "", onbevestigd);
    render(<LoginPage dienst="cloudflare" />);
    expect(await screen.findByRole("alert")).not.toHaveTextContent("klik op de link");
    cleanup();

    // Nu wel zelf begonnen: de pagina stuurt door, Supabase komt terug met de weigering.
    window.history.replaceState(null, "", "/login");
    render(<LoginPage dienst="cloudflare" />);
    await waitFor(() => expect(signInWithOAuth).toHaveBeenCalledTimes(1));
    cleanup();
    window.history.replaceState(null, "", onbevestigd);
    render(<LoginPage dienst="cloudflare" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("klik op de link in die mail");
    expect(document.body).not.toHaveTextContent(/unverified|custom:cloudflare/i);
  });

  it("laadt geen controle tegen robots, ook niet als de sleutel gezet is", async () => {
    render(<LoginPage dienst="cloudflare" robotSleutel="sleutel-van-de-site" />);
    await waitFor(() => expect(signInWithOAuth).toHaveBeenCalled());
    expect(document.head.querySelector('script[src*="turnstile"]')).toBeNull();
  });

  it("laat Supabase terugsturen naar /login, zodat een weigering daar zichtbaar blijft", async () => {
    render(<LoginPage dienst="cloudflare" />);
    await waitFor(() => expect(signInWithOAuth).toHaveBeenCalledTimes(1));
    expect(signInWithOAuth.mock.calls[0]?.[0].options.redirectTo).toBe(
      `${window.location.origin}/login`,
    );
  });

  it("stuurt ook zonder uitleg niet opnieuw door na ?error=access_denied", async () => {
    window.history.replaceState(null, "", "/login?error=access_denied");
    render(<LoginPage dienst="cloudflare" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Inloggen is niet gelukt");
    expect(signInWithOAuth).not.toHaveBeenCalled();
  });

  it("toont een uitleg en een knop als doorsturen mislukt", async () => {
    signInWithOAuth.mockResolvedValue({ data: {}, error: { message: "provider niet gevonden" } });
    render(<LoginPage dienst="cloudflare" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Inloggen is niet gelukt");
    await userEvent.click(screen.getByRole("button", { name: "Opnieuw proberen" }));
    await waitFor(() => expect(signInWithOAuth).toHaveBeenCalledTimes(2));
  });
});

describe("LoginPage met andere diensten", () => {
  it("toont bij azure een knop voor Microsoft", async () => {
    render(<LoginPage dienst="azure" />);
    await userEvent.click(screen.getByRole("button", { name: "Inloggen met Microsoft" }));
    expect(signInWithOAuth.mock.calls[0]?.[0].provider).toBe("azure");
  });

  it("stuurt bij mailcode een inloglink naar het ingevulde adres", async () => {
    render(<LoginPage dienst="mailcode" />);
    await userEvent.type(screen.getByLabelText("E-mailadres"), "piet@klant.nl");
    await userEvent.click(screen.getByRole("button", { name: "Stuur inloglink" }));
    expect(signInWithOtp.mock.calls[0]?.[0].email).toBe("piet@klant.nl");
    expect(signInWithOtp.mock.calls[0]?.[0].options.emailRedirectTo).toBe(
      `${window.location.origin}/login`,
    );
    expect(await screen.findByRole("status")).toHaveTextContent("mail");
  });

  it("verwerkt bij mailcode ook de link uit de inlogmail (token_hash), pas na een klik", async () => {
    // Lokaal en in CI wijst de link in de mail naar /login?token_hash=...&type=email
    // (supabase/templates/inlogcode.html), ook voor een app met alleen mailcode.
    window.history.replaceState(
      null,
      "",
      "/login?token_hash=pkce_0123456789abcdef0123456789abcdef&type=email",
    );
    render(<LoginPage dienst="mailcode" />);
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Stuur inloglink" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Inloggen" }));
    expect(verifyOtp).toHaveBeenCalledWith({
      token_hash: "pkce_0123456789abcdef0123456789abcdef",
      type: "email",
    });
  });

  it("bij alleen mailcode waarschuwt de eigen link in dezelfde browser niet, een link zonder aanvraag wel", async () => {
    const LINK = "/login?token_hash=pkce_0123456789abcdef0123456789abcdef&type=email";
    render(<LoginPage dienst="mailcode" />);
    await userEvent.type(screen.getByLabelText("E-mailadres"), "piet@klant.nl");
    await userEvent.click(screen.getByRole("button", { name: "Stuur inloglink" }));
    await screen.findByText("Kijk in je mail: daar staat een link om in te loggen.");
    expect(JSON.stringify({ ...window.localStorage })).not.toContain("piet");
    cleanup();
    window.history.replaceState(null, "", LINK);
    render(<LoginPage dienst="mailcode" />);
    expect(screen.queryByTestId("link-waarschuwing")).toBeNull();
    cleanup();
    window.localStorage.clear();
    window.history.replaceState(null, "", LINK);
    render(<LoginPage dienst="mailcode" />);
    expect(screen.getByTestId("link-waarschuwing")).toBeInTheDocument();
  });

  it("bij alleen mailcode onthoudt een mislukte aanvraag niets", async () => {
    signInWithOtp.mockResolvedValue({ data: {}, error: { message: "nee", status: 422 } });
    render(<LoginPage dienst="mailcode" />);
    await userEvent.type(screen.getByLabelText("E-mailadres"), "piet@klant.nl");
    await userEvent.click(screen.getByRole("button", { name: "Stuur inloglink" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(window.localStorage.length).toBe(0);
  });

  it("controleert bij mailcode eerst het adres, zonder Supabase aan te roepen", async () => {
    render(<LoginPage dienst="mailcode" />);
    await userEvent.type(screen.getByLabelText("E-mailadres"), "geen-adres");
    await userEvent.click(screen.getByRole("button", { name: "Stuur inloglink" }));
    expect(await screen.findByText("Dit lijkt geen geldig e-mailadres.")).toBeInTheDocument();
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  it("toont bij wachtwoord het formulier zoals voorheen", async () => {
    render(<LoginPage dienst="wachtwoord" />);
    await userEvent.type(screen.getByLabelText("E-mailadres"), "piet@klant.nl");
    await userEvent.type(screen.getByLabelText("Wachtwoord"), "geheim-wachtwoord");
    await userEvent.click(screen.getByRole("button", { name: "Inloggen" }));
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "piet@klant.nl",
      password: "geheim-wachtwoord",
    });
  });
});

describe("LoginPage met een testlogin (alleen lokaal)", () => {
  const testlogin = { email: "testgebruiker@stagetwo.nl", wachtwoord: "nacht-wachtwoord-123" };

  it("toont een duidelijke knop en logt daarmee in als de testgebruiker", async () => {
    render(<LoginPage dienst="wachtwoord" testlogin={testlogin} />);
    expect(screen.getByText(/testgebruiker@stagetwo\.nl/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Inloggen als testgebruiker" }));
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "testgebruiker@stagetwo.nl",
      password: "nacht-wachtwoord-123",
    });
  });

  it("zegt wat te doen als het wachtwoord niet meer klopt", async () => {
    signInWithPassword.mockResolvedValue({ data: {}, error: { message: "Invalid login" } });
    render(<LoginPage dienst="wachtwoord" testlogin={testlogin} />);
    await userEvent.click(screen.getByRole("button", { name: "Inloggen als testgebruiker" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("pnpm testlogin");
  });

  it("zonder testlogin is er geen knop, en het formulier werkt zoals altijd", () => {
    render(<LoginPage dienst="wachtwoord" testlogin={null} />);
    expect(screen.queryByRole("button", { name: "Inloggen als testgebruiker" })).toBeNull();
    expect(screen.getByRole("button", { name: "Inloggen" })).toBeInTheDocument();
  });

  it("standaard (zonder VITE_TESTLOGIN_*) is er geen knop", () => {
    render(<LoginPage dienst="wachtwoord" />);
    expect(screen.queryByRole("button", { name: "Inloggen als testgebruiker" })).toBeNull();
  });
});
