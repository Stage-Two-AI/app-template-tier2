import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const signInWithOAuth = vi.fn();
const signInWithOtp = vi.fn();
const signInWithPassword = vi.fn();

vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { signInWithOAuth, signInWithOtp, signInWithPassword } },
}));

const { LoginPage } = await import("./login-page");

beforeEach(() => {
  signInWithOAuth.mockResolvedValue({ data: {}, error: null });
  signInWithOtp.mockResolvedValue({ data: {}, error: null });
  signInWithPassword.mockResolvedValue({ data: {}, error: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/login");
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
    expect(await screen.findByRole("alert")).toHaveTextContent("geen toegang");
    expect(signInWithOAuth).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Opnieuw proberen" })).toBeInTheDocument();
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
    expect(await screen.findByRole("alert")).toHaveTextContent("access_denied");
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
