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

const KLANTPORTAAL = ["cloudflare", "mailcode"] as const;
const AFGEWEZEN = { message: "Token has expired or is invalid", status: 403, code: "otp_expired" };

beforeEach(() => {
  signInWithOAuth.mockResolvedValue({ data: {}, error: null });
  signInWithOtp.mockResolvedValue({ data: {}, error: null });
  verifyOtp.mockResolvedValue({ data: {}, error: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/login");
});

async function naarCodestap(adres = "piet@klant.nl") {
  await userEvent.type(screen.getByLabelText("E-mailadres"), adres);
  await userEvent.click(screen.getByRole("button", { name: "Doorgaan" }));
  return await screen.findByLabelText("Code van zes cijfers");
}

describe("klantportaal: bij wie log je in", () => {
  afterEach(() => {
    document.title = "";
  });

  it("toont de naam van de app boven het formulier, op elke stap", async () => {
    document.title = "Portaal Jansen";
    render(<LoginPage dienst={KLANTPORTAAL} />);
    expect(screen.getByTestId("merknaam")).toHaveTextContent("Portaal Jansen");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Inloggen");
    await naarCodestap();
    expect(screen.getByTestId("merknaam")).toHaveTextContent("Portaal Jansen");
  });

  it("laat de regel weg als de pagina geen titel heeft", () => {
    render(<LoginPage dienst={KLANTPORTAAL} />);
    expect(screen.queryByTestId("merknaam")).toBeNull();
  });
});

describe("klantportaal: de knop voor medewerkers", () => {
  it("stuurt niet vanzelf door, maar toont een knop en het veld voor klanten", () => {
    render(<LoginPage dienst={KLANTPORTAAL} />);
    expect(screen.getByRole("button", { name: "Inloggen voor medewerkers" })).toBeInTheDocument();
    expect(screen.getByLabelText("E-mailadres")).toBeInTheDocument();
    expect(signInWithOAuth).not.toHaveBeenCalled();
  });

  it("logt een medewerker in via Cloudflare, terug naar /login", async () => {
    render(<LoginPage dienst={KLANTPORTAAL} />);
    await userEvent.click(screen.getByRole("button", { name: "Inloggen voor medewerkers" }));
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: "custom:cloudflare",
      options: { redirectTo: `${window.location.origin}/login` },
    });
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  it("zegt het als doorsturen naar Cloudflare mislukt", async () => {
    signInWithOAuth.mockResolvedValue({ data: {}, error: { message: "provider niet gevonden" } });
    render(<LoginPage dienst={KLANTPORTAAL} />);
    await userEvent.click(screen.getByRole("button", { name: "Inloggen voor medewerkers" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Inloggen is niet gelukt");
  });

  it("toont na een weigering een vaste tekst, nooit de tekst uit het adres", async () => {
    window.history.replaceState(
      null,
      "",
      "/login?error=access_denied&error_description=Bel+0900-1234+voor+je+code",
    );
    render(<LoginPage dienst={KLANTPORTAAL} />);
    const melding = await screen.findByRole("alert");
    expect(melding).toHaveTextContent("Inloggen is niet gelukt");
    expect(melding).not.toHaveTextContent("0900");
    expect(signInWithOAuth).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });
});

describe("klantportaal: Supabase weigert een medewerker na de knop van Cloudflare", () => {
  const ONBEVESTIGD =
    "/login?error=access_denied&error_code=provider_email_needs_verification&error_description=Unverified+email+with+custom%3Acloudflare.+A+confirmation+email+has+been+sent+to+your+custom%3Acloudflare+email";

  it("zegt in gewoon Nederlands wat de medewerker moet doen, zonder de ruwe tekst", async () => {
    window.history.replaceState(null, "", ONBEVESTIGD);
    render(<LoginPage dienst={KLANTPORTAAL} />);
    const melding = await screen.findByRole("alert");
    expect(melding).toHaveTextContent(
      "Je e-mailadres moet nog één keer bevestigd worden. Je hebt daarvoor een mail gekregen: klik op de link in die mail. Log daarna uit en kies opnieuw Inloggen voor medewerkers.",
    );
    expect(document.body).not.toHaveTextContent(/unverified|custom:cloudflare|access_denied/i);
    expect(window.location.search).toBe("");
    expect(signInWithOAuth).not.toHaveBeenCalled();
  });

  it("hangt die melding niet aan het adresveld van de klant", async () => {
    window.history.replaceState(null, "", ONBEVESTIGD);
    render(<LoginPage dienst={KLANTPORTAAL} />);
    await screen.findByRole("alert");
    const veld = screen.getByLabelText("E-mailadres");
    expect(veld).not.toHaveAttribute("aria-describedby");
    expect(veld).not.toHaveAttribute("aria-invalid");
    // De knop voor medewerkers en het formulier voor klanten staan er gewoon nog.
    expect(screen.getByRole("button", { name: "Inloggen voor medewerkers" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Doorgaan" })).toBeEnabled();
  });

  it("zegt het als alleen de beheerder het kan oplossen", async () => {
    window.history.replaceState(
      null,
      "",
      "/login#error=access_denied&error_code=provider_email_needs_verification&error_description=Unverified+email+with+custom%3Acloudflare.+Verify+the+email+with+custom%3Acloudflare+in+order+to+sign+in",
    );
    render(<LoginPage dienst={KLANTPORTAAL} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Vraag je beheerder");
    expect(document.body).not.toHaveTextContent(/unverified|custom:cloudflare/i);
  });
});

describe("klantportaal: de controle tegen robots (Turnstile) als schakelaar", () => {
  type Opties = { sitekey: string; callback: (token: string) => void; appearance: string };
  let widgets: { vak: HTMLElement; opties: Opties }[] = [];
  const reset = vi.fn();
  const remove = vi.fn();

  function zetNepTurnstile() {
    widgets = [];
    window.turnstile = {
      render: (vak, opties) => {
        widgets.push({ vak, opties });
        return `widget-${widgets.length}`;
      },
      reset,
      remove,
    };
  }

  afterEach(() => {
    delete window.turnstile;
    for (const script of document.head.querySelectorAll("script")) script.remove();
  });

  it("zonder sleutel: geen script, geen widget, geen token; alles zoals het was", async () => {
    render(<LoginPage dienst={KLANTPORTAAL} robotSleutel="" />);
    await naarCodestap();
    expect(document.querySelector('script[src*="challenges.cloudflare.com"]')).toBeNull();
    expect(screen.queryByTestId("robotcontrole")).toBeNull();
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: "piet@klant.nl",
      options: { emailRedirectTo: `${window.location.origin}/login`, shouldCreateUser: true },
    });
  });

  it("met sleutel: laadt het script van Cloudflare", () => {
    render(<LoginPage dienst={KLANTPORTAAL} robotSleutel="sleutel-van-de-site" />);
    const script = document.head.querySelector<HTMLScriptElement>("script");
    expect(script?.src).toBe(
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
    );
  });

  it("met sleutel: stuurt het bewijs van de widget mee bij het aanvragen van de code", async () => {
    zetNepTurnstile();
    render(<LoginPage dienst={KLANTPORTAAL} robotSleutel="sleutel-van-de-site" />);
    await waitFor(() => expect(widgets).toHaveLength(1));
    expect(widgets[0]?.opties.sitekey).toBe("sleutel-van-de-site");
    expect(widgets[0]?.opties.appearance).toBe("interaction-only");
    expect(widgets[0]?.vak).toBe(screen.getByTestId("robotcontrole"));
    widgets[0]?.opties.callback("bewijs-1");

    await naarCodestap();
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: "piet@klant.nl",
      options: {
        emailRedirectTo: `${window.location.origin}/login`,
        shouldCreateUser: true,
        captchaToken: "bewijs-1",
      },
    });
  });

  it("wacht op de widget als iemand sneller klikt dan de controle klaar is", async () => {
    zetNepTurnstile();
    render(<LoginPage dienst={KLANTPORTAAL} robotSleutel="sleutel-van-de-site" />);
    await waitFor(() => expect(widgets).toHaveLength(1));
    await userEvent.type(screen.getByLabelText("E-mailadres"), "piet@klant.nl");
    await userEvent.click(screen.getByRole("button", { name: "Doorgaan" }));
    expect(screen.getByRole("button", { name: "Bezig…" })).toBeDisabled();
    expect(signInWithOtp).not.toHaveBeenCalled();

    widgets[0]?.opties.callback("bewijs-laat");
    await screen.findByLabelText("Code van zes cijfers");
    expect(signInWithOtp.mock.calls[0]?.[0].options.captchaToken).toBe("bewijs-laat");
  });

  it("gebruikt voor een nieuwe code een nieuw bewijs: elk bewijs werkt één keer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    zetNepTurnstile();
    render(<LoginPage dienst={KLANTPORTAAL} robotSleutel="sleutel-van-de-site" />);
    await waitFor(() => expect(widgets).toHaveLength(1));
    widgets[0]?.opties.callback("bewijs-1");
    await user.type(screen.getByLabelText("E-mailadres"), "piet@klant.nl");
    await user.click(screen.getByRole("button", { name: "Doorgaan" }));
    await screen.findByLabelText("Code van zes cijfers");
    // De widget van het eerste scherm is weg; die op het codescherm haalt een nieuw bewijs.
    await waitFor(() => expect(widgets).toHaveLength(2));
    expect(remove).toHaveBeenCalledWith("widget-1");
    expect(widgets[1]?.vak).toBe(screen.getByTestId("robotcontrole"));
    widgets[1]?.opties.callback("bewijs-2");

    await vi.advanceTimersByTimeAsync(61_000);
    const opnieuw = await screen.findByRole(
      "button",
      { name: "Stuur een nieuwe code" },
      { timeout: 4000 },
    );
    await user.click(opnieuw);
    await waitFor(() => expect(signInWithOtp).toHaveBeenCalledTimes(2));
    expect(signInWithOtp.mock.calls[1]?.[0].options.captchaToken).toBe("bewijs-2");
    // En daarna vraagt de pagina de widget om weer een nieuw bewijs.
    expect(reset).toHaveBeenCalledWith("widget-2");
  });

  it("zegt het als de controle niet lukt, en vraagt dan geen code aan", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    zetNepTurnstile();
    render(<LoginPage dienst={KLANTPORTAAL} robotSleutel="sleutel-van-de-site" />);
    await waitFor(() => expect(widgets).toHaveLength(1));
    await user.type(screen.getByLabelText("E-mailadres"), "piet@klant.nl");
    await user.click(screen.getByRole("button", { name: "Doorgaan" }));
    await vi.advanceTimersByTimeAsync(16_000);
    expect(await screen.findByRole("alert")).toHaveTextContent("geen robot");
    expect(signInWithOtp).not.toHaveBeenCalled();
    expect(screen.getByLabelText("E-mailadres")).toHaveValue("piet@klant.nl");
  });

  it("zegt het als Supabase de controle afkeurt (sleutel hier ontbreekt of klopt niet)", async () => {
    signInWithOtp.mockResolvedValue({
      data: {},
      error: { message: "captcha protection", status: 400, code: "captcha_failed" },
    });
    render(<LoginPage dienst={KLANTPORTAAL} robotSleutel="" />);
    await userEvent.type(screen.getByLabelText("E-mailadres"), "piet@klant.nl");
    await userEvent.click(screen.getByRole("button", { name: "Doorgaan" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("geen robot");
    expect(screen.queryByLabelText("Code van zes cijfers")).toBeNull();
  });

  it("een tikfout in het adres wacht niet op de controle", async () => {
    zetNepTurnstile();
    render(<LoginPage dienst={KLANTPORTAAL} robotSleutel="sleutel-van-de-site" />);
    await userEvent.type(screen.getByLabelText("E-mailadres"), "geen-adres");
    await userEvent.click(screen.getByRole("button", { name: "Doorgaan" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("geen geldig e-mailadres");
  });
});

describe("klantportaal: een klant logt in met de code uit de mail", () => {
  it("vraagt de code aan en toont daarna het codevak, klaar voor een telefoon", async () => {
    render(<LoginPage dienst={KLANTPORTAAL} />);
    const code = await naarCodestap(" Piet@Klant.nl ");
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: "piet@klant.nl",
      options: { emailRedirectTo: `${window.location.origin}/login`, shouldCreateUser: true },
    });
    expect(screen.getByRole("heading", { name: "Vul de code in" })).toBeInTheDocument();
    expect(screen.getByText("piet@klant.nl")).toBeInTheDocument();
    expect(code).toHaveAttribute("autocomplete", "one-time-code");
    expect(code).toHaveAttribute("inputmode", "numeric");
    expect(code).toHaveFocus();
    // De knop voor medewerkers hoort niet bij deze stap.
    expect(screen.queryByRole("button", { name: "Inloggen voor medewerkers" })).toBeNull();
  });

  it("controleert de code zodra er zes cijfers staan", async () => {
    render(<LoginPage dienst={KLANTPORTAAL} />);
    const code = await naarCodestap();
    await userEvent.type(code, "123456");
    await waitFor(() => expect(verifyOtp).toHaveBeenCalledTimes(1));
    expect(verifyOtp).toHaveBeenCalledWith({
      email: "piet@klant.nl",
      token: "123456",
      type: "email",
    });
  });

  it("neemt een geplakte code met een spatie aan", async () => {
    render(<LoginPage dienst={KLANTPORTAAL} />);
    const code = await naarCodestap();
    await userEvent.click(code);
    await userEvent.paste("654 321");
    await waitFor(() => expect(verifyOtp).toHaveBeenCalledTimes(1));
    expect(verifyOtp.mock.calls[0]?.[0].token).toBe("654321");
  });

  it("zegt het bij een foute code en laat opnieuw proberen", async () => {
    verifyOtp.mockResolvedValueOnce({ data: {}, error: AFGEWEZEN });
    render(<LoginPage dienst={KLANTPORTAAL} />);
    const code = await naarCodestap();
    await userEvent.type(code, "000000");
    expect(await screen.findByRole("alert")).toHaveTextContent("Deze code klopt niet");
    expect(code).toHaveAttribute("aria-invalid", "true");
    expect(code).toHaveFocus();
    await userEvent.clear(code);
    await userEvent.type(code, "123456");
    await waitFor(() => expect(verifyOtp).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("geeft een ongeldig adres terug zonder Supabase aan te roepen", async () => {
    render(<LoginPage dienst={KLANTPORTAAL} />);
    await userEvent.type(screen.getByLabelText("E-mailadres"), "geen-adres");
    await userEvent.click(screen.getByRole("button", { name: "Doorgaan" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("geen geldig e-mailadres");
    expect(signInWithOtp).not.toHaveBeenCalled();
    expect(screen.getByLabelText("E-mailadres")).toHaveAttribute("aria-invalid", "true");
  });

  it("toont bij een bekend en een onbekend adres precies hetzelfde scherm", async () => {
    render(<LoginPage dienst={KLANTPORTAAL} />);
    await naarCodestap("bekend@klant.nl");
    const bekend = document.body.innerHTML.replaceAll("bekend@", "x@");
    cleanup();
    window.sessionStorage.clear();

    signInWithOtp.mockResolvedValue({
      data: {},
      error: { message: "Signups not allowed for otp", status: 422, code: "otp_disabled" },
    });
    render(<LoginPage dienst={KLANTPORTAAL} />);
    await naarCodestap("onbekend@klant.nl");
    expect(document.body.innerHTML.replaceAll("onbekend@", "x@")).toBe(bekend);
  });

  it("zegt het bij te veel pogingen en blijft op het adres staan", async () => {
    signInWithOtp.mockResolvedValue({
      data: {},
      error: { message: "rate limit", status: 429, code: "over_email_send_rate_limit" },
    });
    render(<LoginPage dienst={KLANTPORTAAL} />);
    await userEvent.type(screen.getByLabelText("E-mailadres"), "piet@klant.nl");
    await userEvent.click(screen.getByRole("button", { name: "Doorgaan" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Te veel pogingen");
    expect(screen.getByLabelText("E-mailadres")).toHaveValue("piet@klant.nl");
  });

  it("laat een verkeerd adres aanpassen, met het oude adres nog ingevuld", async () => {
    render(<LoginPage dienst={KLANTPORTAAL} />);
    await naarCodestap("piet@klnat.nl");
    await userEvent.click(screen.getByRole("button", { name: "Ander e-mailadres" }));
    expect(screen.getByLabelText("E-mailadres")).toHaveValue("piet@klnat.nl");
    expect(screen.getByRole("button", { name: "Inloggen voor medewerkers" })).toBeInTheDocument();
  });

  it("komt na opnieuw laden (wisselen naar de mail-app) terug op het codevak", async () => {
    render(<LoginPage dienst={KLANTPORTAAL} />);
    await naarCodestap();
    cleanup();
    render(<LoginPage dienst={KLANTPORTAAL} />);
    expect(screen.getByLabelText("Code van zes cijfers")).toBeInTheDocument();
    expect(screen.getByText("piet@klant.nl")).toBeInTheDocument();
    expect(signInWithOtp).toHaveBeenCalledTimes(1);
  });
});

describe("klantportaal: nieuwe code en verlopen code", () => {
  const START = new Date("2026-11-14T10:00:00Z");

  function metKlok() {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: START });
    return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  }

  async function naarCode(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText("E-mailadres"), "piet@klant.nl");
    await user.click(screen.getByRole("button", { name: "Doorgaan" }));
    return await screen.findByLabelText("Code van zes cijfers");
  }

  it("laat pas na een minuut een nieuwe code sturen", async () => {
    const user = metKlok();
    render(<LoginPage dienst={KLANTPORTAAL} />);
    await naarCode(user);
    expect(screen.getByRole("button", { name: /Nieuwe code kan over \d+ s/ })).toBeDisabled();

    await vi.advanceTimersByTimeAsync(61_000);
    // De klok op de pagina tikt per seconde; geef hem even om bij te komen.
    const opnieuw = await screen.findByRole(
      "button",
      { name: "Stuur een nieuwe code" },
      { timeout: 4000 },
    );
    await user.click(opnieuw);
    await waitFor(() => expect(signInWithOtp).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("status")).toHaveTextContent("nieuwe code verstuurd");
    expect(screen.getByRole("button", { name: /Nieuwe code kan over/ })).toBeDisabled();
  });

  it("zegt na een kwartier dat de code verlopen is", async () => {
    verifyOtp.mockResolvedValue({ data: {}, error: AFGEWEZEN });
    const user = metKlok();
    render(<LoginPage dienst={KLANTPORTAAL} />);
    const code = await naarCode(user);
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    await user.type(code, "123456");
    expect(await screen.findByRole("alert")).toHaveTextContent("verlopen");
    expect(
      await screen.findByRole("button", { name: "Stuur een nieuwe code" }, { timeout: 4000 }),
    ).toBeEnabled();
  });
});

describe("klantportaal: de link uit de mail", () => {
  const LINK = "/login?token_hash=pkce_0123456789abcdef0123456789abcdef&type=email";

  it("logt pas in na een klik, niet vanzelf bij het openen", async () => {
    window.history.replaceState(null, "", LINK);
    render(<LoginPage dienst={KLANTPORTAAL} />);
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("E-mailadres")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Inloggen" }));
    expect(verifyOtp).toHaveBeenCalledWith({
      token_hash: "pkce_0123456789abcdef0123456789abcdef",
      type: "email",
    });
  });

  it("biedt bij een verlopen link het formulier aan en maakt het adres schoon", async () => {
    verifyOtp.mockResolvedValue({
      data: {},
      error: { message: "Email link is invalid or has expired", status: 403, code: "otp_expired" },
    });
    window.history.replaceState(null, "", LINK);
    render(<LoginPage dienst={KLANTPORTAAL} />);
    await userEvent.click(screen.getByRole("button", { name: "Inloggen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("verlopen of al gebruikt");
    expect(screen.getByLabelText("E-mailadres")).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  it("neemt geen ander soort link aan", () => {
    window.history.replaceState(null, "", "/login?token_hash=0123456789abcdef0123&type=recovery");
    render(<LoginPage dienst={KLANTPORTAAL} />);
    expect(screen.getByLabelText("E-mailadres")).toBeInTheDocument();
    expect(verifyOtp).not.toHaveBeenCalled();
  });
});

describe("één dienst blijft de pagina van die dienst", () => {
  it("een lijst met alleen cloudflare stuurt meteen door, zoals altijd", async () => {
    render(<LoginPage dienst={["cloudflare"]} />);
    await waitFor(() => expect(signInWithOAuth).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status")).toHaveTextContent("doorgestuurd");
    expect(screen.queryByRole("button", { name: "Inloggen voor medewerkers" })).toBeNull();
  });

  it("alleen mailcode houdt het formulier met de inloglink", () => {
    render(<LoginPage dienst="mailcode" />);
    expect(screen.getByRole("button", { name: "Stuur inloglink" })).toBeInTheDocument();
  });
});
