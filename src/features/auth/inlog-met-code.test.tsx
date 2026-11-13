import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
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
const { useMailcode } = await import("./use-mailcode");

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
  window.localStorage.clear();
  window.history.replaceState(null, "", "/login");
});

async function naarCodestap(adres = "piet@klant.nl") {
  await userEvent.type(screen.getByLabelText("E-mailadres"), adres);
  await userEvent.click(screen.getByRole("button", { name: "Doorgaan" }));
  return await screen.findByLabelText("Code van tien cijfers");
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

  it("wijst een medewerker onder het vak voor klanten op de knop: één account per adres", () => {
    render(<LoginPage dienst={KLANTPORTAAL} />);
    expect(
      screen.getByText("Werk je hier? Gebruik de knop Inloggen voor medewerkers."),
    ).toBeInTheDocument();
    cleanup();
    // Zonder knop voor medewerkers is er niets om naar te wijzen.
    render(<LoginPage dienst={["mailcode", "google"]} />);
    expect(screen.queryByText(/Werk je hier/)).toBeNull();
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

  /** De medewerker klikt op de knop; Supabase stuurt hem daarna terug met een weigering. */
  async function naDeKnop(terug: string) {
    render(<LoginPage dienst={KLANTPORTAAL} />);
    await userEvent.click(screen.getByRole("button", { name: "Inloggen voor medewerkers" }));
    cleanup();
    window.history.replaceState(null, "", terug);
    render(<LoginPage dienst={KLANTPORTAAL} />);
  }

  it("zegt in gewoon Nederlands wat de medewerker moet doen, zonder de ruwe tekst", async () => {
    await naDeKnop(ONBEVESTIGD);
    const melding = await screen.findByRole("alert");
    expect(melding).toHaveTextContent(
      "Je e-mailadres moet nog één keer bevestigd worden. Je hebt daarvoor een mail gekregen: klik op de link in die mail. Kom daarna terug op deze pagina en kies opnieuw Inloggen voor medewerkers.",
    );
    expect(document.body).not.toHaveTextContent(/unverified|custom:cloudflare|access_denied/i);
    expect(window.location.search).toBe("");
    expect(signInWithOAuth).toHaveBeenCalledTimes(1);
  });

  it("toont die uitleg niet aan wie alleen een link kreeg: dan de neutrale melding", async () => {
    // Een vreemde vraagt een code aan op het adres van het slachtoffer (dat krijgt een echte
    // inlogmail) en stuurt daarna deze link. De echte inlogpagina zegt dan niet zelf dat het
    // slachtoffer op de link in die mail moet klikken.
    window.history.replaceState(null, "", ONBEVESTIGD);
    render(<LoginPage dienst={KLANTPORTAAL} />);
    const melding = await screen.findByRole("alert");
    expect(melding).toHaveTextContent("Inloggen is niet gelukt. Probeer het opnieuw.");
    expect(document.body).not.toHaveTextContent(/klik op de link|beheerder/);
  });

  it("hangt die melding niet aan het adresveld van de klant", async () => {
    await naDeKnop(ONBEVESTIGD);
    await screen.findByRole("alert");
    const veld = screen.getByLabelText("E-mailadres");
    expect(veld).not.toHaveAttribute("aria-describedby");
    expect(veld).not.toHaveAttribute("aria-invalid");
    // De knop voor medewerkers en het formulier voor klanten staan er gewoon nog.
    expect(screen.getByRole("button", { name: "Inloggen voor medewerkers" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Doorgaan" })).toBeEnabled();
  });

  it("zegt eerlijk wat er aan de hand is als alleen de beheerder het kan oplossen", async () => {
    await naDeKnop(
      "/login#error=access_denied&error_code=provider_email_needs_verification&error_description=Unverified+email+with+custom%3Acloudflare.+Verify+the+email+with+custom%3Acloudflare+in+order+to+sign+in",
    );
    const melding = await screen.findByRole("alert");
    expect(melding).toHaveTextContent("bestaat al een account dat nog niet bevestigd is");
    expect(melding).toHaveTextContent(
      "Vraag je beheerder om dat account in Supabase (Authentication, Users) te bevestigen of te verwijderen",
    );
    expect(document.body).not.toHaveTextContent(/unverified|custom:cloudflare/i);
  });
});

describe("klantportaal: de controle tegen robots (Turnstile) als schakelaar", () => {
  type Opties = {
    sitekey: string;
    callback: (token: string) => void;
    "expired-callback": () => void;
    appearance: string;
    action: string;
  };
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
    // Het bewijs geldt alleen voor deze actie; Supabase en Cloudflare zien waar het voor was.
    expect(widgets[0]?.opties.action).toBe("inlogcode");
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
    await screen.findByLabelText("Code van tien cijfers");
    expect(signInWithOtp.mock.calls[0]?.[0].options.captchaToken).toBe("bewijs-laat");
  });

  it("stuurt een verlopen bewijs niet mee: de pagina wacht op een nieuw", async () => {
    zetNepTurnstile();
    render(<LoginPage dienst={KLANTPORTAAL} robotSleutel="sleutel-van-de-site" />);
    await waitFor(() => expect(widgets).toHaveLength(1));
    widgets[0]?.opties.callback("oud-bewijs");
    // Turnstile meldt na vijf minuten dat het bewijs verlopen is.
    widgets[0]?.opties["expired-callback"]();
    await userEvent.type(screen.getByLabelText("E-mailadres"), "piet@klant.nl");
    await userEvent.click(screen.getByRole("button", { name: "Doorgaan" }));
    expect(screen.getByRole("button", { name: "Bezig…" })).toBeDisabled();
    expect(signInWithOtp).not.toHaveBeenCalled();
    widgets[0]?.opties.callback("nieuw-bewijs");
    await screen.findByLabelText("Code van tien cijfers");
    expect(signInWithOtp.mock.calls[0]?.[0].options.captchaToken).toBe("nieuw-bewijs");
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
    await screen.findByLabelText("Code van tien cijfers");
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
    expect(screen.queryByLabelText("Code van tien cijfers")).toBeNull();
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

  it("controleert de code zodra er tien cijfers staan", async () => {
    render(<LoginPage dienst={KLANTPORTAAL} />);
    const code = await naarCodestap();
    await userEvent.type(code, "1234567890");
    await waitFor(() => expect(verifyOtp).toHaveBeenCalledTimes(1));
    expect(verifyOtp).toHaveBeenCalledWith({
      email: "piet@klant.nl",
      token: "1234567890",
      type: "email",
    });
  });

  it("vergeet na het inloggen naar welk adres de code ging", async () => {
    render(<LoginPage dienst={KLANTPORTAAL} />);
    const code = await naarCodestap("vorige@klant.nl");
    expect(JSON.stringify({ ...window.sessionStorage })).toContain("vorige@klant.nl");
    expect(window.localStorage.length).toBe(1);
    await userEvent.type(code, "1234567890");
    await waitFor(() => expect(verifyOtp).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(window.sessionStorage.length).toBe(0));
    // De aanvraag blijft tot de app het adres van het account ermee heeft vergeleken
    // (app-met-database.tsx); daar wordt hij gewist.
    expect(window.localStorage.length).toBe(1);
    // De volgende op dit tabblad begint bij een leeg formulier.
    cleanup();
    render(<LoginPage dienst={KLANTPORTAAL} />);
    expect(screen.getByLabelText("E-mailadres")).toHaveValue("");
    expect(document.body).not.toHaveTextContent("vorige@klant.nl");
  });

  it("bewaart buiten het tabblad alleen dat er een code is aangevraagd, niet het adres", async () => {
    render(<LoginPage dienst={KLANTPORTAAL} />);
    await naarCodestap("piet@klant.nl");
    expect(JSON.stringify({ ...window.localStorage })).not.toContain("piet");
  });

  it("neemt een geplakte code met een spatie aan", async () => {
    render(<LoginPage dienst={KLANTPORTAAL} />);
    const code = await naarCodestap();
    await userEvent.click(code);
    await userEvent.paste("98765 43210");
    await waitFor(() => expect(verifyOtp).toHaveBeenCalledTimes(1));
    expect(verifyOtp.mock.calls[0]?.[0].token).toBe("9876543210");
  });

  it("zegt het bij een foute code en laat opnieuw proberen", async () => {
    verifyOtp.mockResolvedValueOnce({ data: {}, error: AFGEWEZEN });
    render(<LoginPage dienst={KLANTPORTAAL} />);
    const code = await naarCodestap();
    await userEvent.type(code, "0000000000");
    expect(await screen.findByRole("alert")).toHaveTextContent("Deze code klopt niet");
    expect(code).toHaveAttribute("aria-invalid", "true");
    expect(code).toHaveFocus();
    await userEvent.clear(code);
    await userEvent.type(code, "1234567890");
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

  it("toont ook bij een weigering die als storing terugkomt hetzelfde scherm", async () => {
    // Een hook van de inrichting die het adres van een medewerker weigert, kan als 500
    // terugkomen. De pagina zegt dan niet "geen verbinding": daaraan zou het adres te zien zijn.
    signInWithOtp.mockResolvedValue({
      data: {},
      error: { status: 500, code: "hook_failed", message: "weigering" },
    });
    render(<LoginPage dienst={KLANTPORTAAL} />);
    await naarCodestap("medewerker@bedrijf.nl");
    expect(screen.queryByRole("alert")).toBeNull();
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

  it("toont het adres van de vorige niet meer als die vijf minuten geleden een code aanvroeg", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date("2026-11-14T10:00:00Z") });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<LoginPage dienst={KLANTPORTAAL} />);
    await user.type(screen.getByLabelText("E-mailadres"), "vorige@klant.nl");
    await user.click(screen.getByRole("button", { name: "Doorgaan" }));
    await screen.findByLabelText("Code van tien cijfers");
    cleanup();
    // Een ander gaat op dezelfde computer in hetzelfde tabblad naar de inlogpagina.
    vi.setSystemTime(new Date("2026-11-14T10:05:01Z"));
    render(<LoginPage dienst={KLANTPORTAAL} />);
    expect(screen.getByLabelText("E-mailadres")).toHaveValue("");
    expect(document.body).not.toHaveTextContent("vorige@klant.nl");
  });

  it("komt na opnieuw laden (wisselen naar de mail-app) terug op het codevak", async () => {
    render(<LoginPage dienst={KLANTPORTAAL} />);
    await naarCodestap();
    cleanup();
    render(<LoginPage dienst={KLANTPORTAAL} />);
    expect(screen.getByLabelText("Code van tien cijfers")).toBeInTheDocument();
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
    return await screen.findByLabelText("Code van tien cijfers");
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

  it("vraagt binnen de minuut geen tweede code aan, ook niet buiten de knop om", async () => {
    // De knop staat dan uit, maar de wachttijd zit ook in de stap zelf.
    const auth = { signInWithOtp, verifyOtp, signInWithOAuth };
    const { result } = renderHook(() => useMailcode(auth, () => "https://app.test/login"));
    await result.current.verstuur("piet@klant.nl");
    await waitFor(() => expect(result.current.toestand.stap).toBe("code"));
    await result.current.opnieuw();
    await result.current.opnieuw();
    expect(signInWithOtp).toHaveBeenCalledTimes(1);
    expect(result.current.wachtNog).toBeGreaterThan(0);
  });

  it("zegt na een kwartier dat de code verlopen is", async () => {
    verifyOtp.mockResolvedValue({ data: {}, error: AFGEWEZEN });
    const user = metKlok();
    render(<LoginPage dienst={KLANTPORTAAL} />);
    const code = await naarCode(user);
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    await user.type(code, "1234567890");
    expect(await screen.findByRole("alert")).toHaveTextContent("verlopen");
    expect(
      await screen.findByRole("button", { name: "Stuur een nieuwe code" }, { timeout: 4000 }),
    ).toBeEnabled();
  });
});

describe("klantportaal: de link uit de mail", () => {
  const LINK = "/login?token_hash=pkce_0123456789abcdef0123456789abcdef&type=email";

  it("waarschuwt vóór de knop als de mail niet in deze browser is aangevraagd", async () => {
    // Een ander kan je de link uit zíjn inlogmail sturen: dan log je in op zijn account.
    window.history.replaceState(null, "", LINK);
    render(<LoginPage dienst={KLANTPORTAAL} />);
    const waarschuwing = screen.getByTestId("link-waarschuwing");
    expect(waarschuwing).toHaveTextContent("Heb je deze mail zelf aangevraagd?");
    expect(waarschuwing).toHaveTextContent("dan kom je in het account van die ander");
    // De knop staat er nog: wie het zelf aanvroeg in een andere browser, kan gewoon door.
    expect(verifyOtp).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Inloggen" }));
    expect(verifyOtp).toHaveBeenCalledTimes(1);
  });

  it("waarschuwt niet als deze browser de code zelf net aanvroeg, ook in een nieuw tabblad", async () => {
    render(<LoginPage dienst={KLANTPORTAAL} />);
    await naarCodestap();
    cleanup();
    // De link uit de mail opent in een nieuw tabblad: zonder wat het eerste tabblad onthield.
    window.sessionStorage.clear();
    window.history.replaceState(null, "", LINK);
    render(<LoginPage dienst={KLANTPORTAAL} />);
    expect(screen.queryByTestId("link-waarschuwing")).toBeNull();
    expect(screen.getByText("Je bent er bijna. Klik op de knop om in te loggen.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Inloggen" }));
    await waitFor(() => expect(verifyOtp).toHaveBeenCalledTimes(1));
  });

  it("een aanvraag die Supabase stil weigerde, telt niet: dan waarschuwt de link wel", async () => {
    signInWithOtp.mockResolvedValue({
      data: {},
      error: { message: "Signups not allowed for otp", status: 422, code: "otp_disabled" },
    });
    render(<LoginPage dienst={KLANTPORTAAL} />);
    await naarCodestap();
    expect(window.localStorage.length).toBe(0);
    cleanup();
    window.history.replaceState(null, "", LINK);
    render(<LoginPage dienst={KLANTPORTAAL} />);
    expect(screen.getByTestId("link-waarschuwing")).toBeInTheDocument();
  });

  it("na 'Ander e-mailadres' telt de vorige aanvraag niet meer", async () => {
    render(<LoginPage dienst={KLANTPORTAAL} />);
    await naarCodestap();
    expect(window.localStorage.length).toBe(1);
    await userEvent.click(screen.getByRole("button", { name: "Ander e-mailadres" }));
    expect(window.localStorage.length).toBe(0);
    cleanup();
    window.history.replaceState(null, "", LINK);
    render(<LoginPage dienst={KLANTPORTAAL} />);
    expect(screen.getByTestId("link-waarschuwing")).toBeInTheDocument();
  });

  it("waarschuwt weer als de aanvraag ouder is dan de mail geldig is", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date("2026-11-14T10:00:00Z") });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<LoginPage dienst={KLANTPORTAAL} />);
    await user.type(screen.getByLabelText("E-mailadres"), "piet@klant.nl");
    await user.click(screen.getByRole("button", { name: "Doorgaan" }));
    await screen.findByLabelText("Code van tien cijfers");
    cleanup();
    vi.setSystemTime(new Date("2026-11-14T10:15:01Z"));
    window.history.replaceState(null, "", LINK);
    render(<LoginPage dienst={KLANTPORTAAL} />);
    expect(screen.getByTestId("link-waarschuwing")).toBeInTheDocument();
  });

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
