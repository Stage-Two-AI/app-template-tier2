import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { leesInlogdiensten } from "./inlogdienst";
import { type TurnstileApi, useRobotcontrole } from "./robotcontrole";

/**
 * AANVALSTESTS op de inlogpagina (uitgave 43, stuk A3). Elke test SLAAGT als de aanval lukt.
 * Een rode test hier betekent dus: de verdediging hield stand.
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
const TEKST_VAN_AANVALLER = "Uw account is geblokkeerd. Bel 0900-1234 en geef uw code door.";

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
  delete window.turnstile;
  for (const script of document.head.querySelectorAll("script")) script.remove();
});

describe("doel 3: tekst van de aanvaller op het inlogscherm via de adresbalk", () => {
  it("3.1 klantportaal: error_description uit het adres staat letterlijk op het scherm", () => {
    window.history.replaceState(
      null,
      "",
      `/login?error=x&error_description=${encodeURIComponent(TEKST_VAN_AANVALLER)}`,
    );
    render(<LoginPage dienst={KLANTPORTAAL} robotSleutel="" />);
    expect(document.body.textContent).toContain("0900-1234");
  });

  it("3.2 klantportaal: hetzelfde via het hash-fragment, ?error= en ?code=", () => {
    window.history.replaceState(
      null,
      "",
      `/login?code=${encodeURIComponent(TEKST_VAN_AANVALLER)}&error=${encodeURIComponent(TEKST_VAN_AANVALLER)}#error_description=${encodeURIComponent(TEKST_VAN_AANVALLER)}`,
    );
    render(<LoginPage dienst={KLANTPORTAAL} robotSleutel="" />);
    expect(document.body.textContent).toContain("0900-1234");
  });

  it("3.3 klantportaal: de aanvaller kiest met een link welke vaste melding het slachtoffer ziet ('klik op de link in die mail')", () => {
    // De aanvaller vraagt eerst een code aan op het adres van het slachtoffer (dat krijgt een
    // echte inlogmail) en stuurt daarna deze link. De echte inlogpagina zegt dan zelf dat het
    // slachtoffer op de link in die mail moet klikken, terwijl de mail zegt dat niet te doen.
    window.history.replaceState(
      null,
      "",
      "/login?error_description=Unverified+email+with+x.+A+confirmation+email+has+been+sent",
    );
    render(<LoginPage dienst={KLANTPORTAAL} robotSleutel="" />);
    expect(screen.getByRole("alert")).toHaveTextContent("klik op de link in die mail");
  });

  it("3.4 één dienst (cloudflare): error_description uit het adres staat letterlijk op het scherm", async () => {
    window.history.replaceState(
      null,
      "",
      `/login?error_description=${encodeURIComponent(TEKST_VAN_AANVALLER)}`,
    );
    render(<LoginPage dienst="cloudflare" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(TEKST_VAN_AANVALLER);
  });

  it("3.5 klantportaal: een link met een ander type dan email (recovery, email_change) wordt toch verzilverd", async () => {
    window.history.replaceState(null, "", `/login?token_hash=${"a".repeat(56)}&type=recovery`);
    render(<LoginPage dienst={KLANTPORTAAL} robotSleutel="" />);
    const knop = screen.queryByRole("button", { name: "Inloggen" });
    expect(knop).not.toBeNull();
    if (knop) await userEvent.click(knop);
    expect(verifyOtp).toHaveBeenCalled();
  });

  it("3.6 sessionStorage: na inloggen met de code staat het adres van de vorige gebruiker nog in het tabblad", async () => {
    render(<LoginPage dienst={KLANTPORTAAL} robotSleutel="" />);
    await userEvent.type(screen.getByLabelText("E-mailadres"), "vorige@klant.nl");
    await userEvent.click(screen.getByRole("button", { name: "Doorgaan" }));
    await userEvent.type(await screen.findByLabelText("Code van acht cijfers"), "12345678");
    await waitFor(() => expect(verifyOtp).toHaveBeenCalled());
    await waitFor(() => expect(verifyOtp.mock.results[0]?.type).toBe("return"));
    expect(JSON.stringify({ ...window.sessionStorage })).toContain("vorige@klant.nl");
  });

  it("3.7 sessionStorage: een code aangevraagd maar niet ingevuld; de volgende op dit tabblad ziet het adres van de vorige", async () => {
    render(<LoginPage dienst={KLANTPORTAAL} robotSleutel="" />);
    await userEvent.type(screen.getByLabelText("E-mailadres"), "vorige@klant.nl");
    await userEvent.click(screen.getByRole("button", { name: "Doorgaan" }));
    await screen.findByLabelText("Code van acht cijfers");
    cleanup();
    // Een ander gaat op dezelfde (gedeelde) computer in hetzelfde tabblad naar /login.
    render(<LoginPage dienst={KLANTPORTAAL} robotSleutel="" />);
    expect(document.body.textContent).toContain("vorige@klant.nl");
  });

  it("3.8 de pagina zelf toont bij een bekend en een onbekend adres iets anders", async () => {
    // Bekend adres: Supabase stuurt een mail. Onbekend adres dat niet mag: Supabase weigert.
    const uitkomsten: string[] = [];
    for (const antwoord of [
      { data: {}, error: null },
      { data: {}, error: { status: 422, code: "signup_disabled", message: "Signups not allowed" } },
      { data: {}, error: { status: 400, code: "email_address_invalid", message: "invalid" } },
      { data: {}, error: { status: 403, code: "user_banned", message: "User is banned" } },
    ]) {
      signInWithOtp.mockResolvedValueOnce(antwoord);
      render(<LoginPage dienst={KLANTPORTAAL} robotSleutel="" />);
      await userEvent.type(screen.getByLabelText("E-mailadres"), "iemand@klant.nl");
      await userEvent.click(screen.getByRole("button", { name: "Doorgaan" }));
      await waitFor(() => expect(screen.queryByText("Bezig…")).toBeNull());
      uitkomsten.push(document.body.textContent ?? "");
      cleanup();
      window.sessionStorage.clear();
    }
    expect(new Set(uitkomsten).size).toBeGreaterThan(1);
  });

  it("3.9 de pagina toont iets anders als de hook van de inrichting een adres weigert met een 5xx of zonder status", async () => {
    // Een hook die nee zegt, komt bij Supabase Auth soms terug als 500 (hook mislukt) in
    // plaats van 4xx. mailcode.ts toont dan "geen verbinding" in plaats van "vul de code in":
    // daaraan is te zien dat dit adres anders is dan andere (een adres van een medewerker).
    signInWithOtp.mockResolvedValueOnce({
      data: {},
      error: { status: 500, code: "hook_failed", message: "weigering" },
    });
    render(<LoginPage dienst={KLANTPORTAAL} robotSleutel="" />);
    await userEvent.type(screen.getByLabelText("E-mailadres"), "medewerker@bedrijf.nl");
    await userEvent.click(screen.getByRole("button", { name: "Doorgaan" }));
    await waitFor(() => expect(screen.queryByText("Bezig…")).toBeNull());
    expect(screen.queryByLabelText("Code van acht cijfers")).toBeNull();
  });
});

describe("doel 5: één dienst blijft als vanouds", () => {
  it("5.1 een app van vóór 43 die `cloudflare,mailcode` krijgt, start niet meer (controle van de omgeving faalt)", () => {
    // Zo stond het op origin/main in src/lib/env.ts: `VITE_INLOGDIENST: z.enum(INLOGDIENSTEN)`.
    const vanVoor43 = z.enum(["cloudflare", "azure", "google", "mailcode", "wachtwoord"]);
    expect(vanVoor43.safeParse("cloudflare,mailcode").success).toBe(false);
  });

  it("5.2 een waarde die op main een fout gaf, is nu geldig (spaties, lege waarde na komma)", () => {
    const vanVoor43 = z.enum(["cloudflare", "azure", "google", "mailcode", "wachtwoord"]);
    const waarden = [" cloudflare", "cloudflare ", "cloudflare,", ",cloudflare", "Cloudflare"];
    const anders = waarden.filter(
      (waarde) => vanVoor43.safeParse(waarde).success !== leesInlogdiensten(waarde).ok,
    );
    expect(anders.length).toBeGreaterThan(0);
  });

  it("5.3 alleen `mailcode`: de link uit de lokale inlogmail (token_hash) doet op die pagina niets meer", async () => {
    // supabase/config.toml stuurt sinds 43 voor élke app lokaal en in CI de mail uit
    // templates/inlogcode.html, met een link naar /login?token_hash=...&type=email. De pagina
    // van één dienst `mailcode` ("Stuur inloglink") kent token_hash niet. Op main ging de link
    // naar Supabase zelf en logde hij in.
    window.history.replaceState(null, "", `/login?token_hash=${"a".repeat(56)}&type=email`);
    render(<LoginPage dienst="mailcode" />);
    await new Promise((klaar) => setTimeout(klaar, 50));
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Inloggen" })).toBeNull();
    expect(screen.getByRole("button", { name: "Stuur inloglink" })).toBeInTheDocument();
  });

  it("5.4 alleen `cloudflare`: met VITE_TURNSTILE_SITEKEY gezet wordt er toch een script van Turnstile geladen", async () => {
    render(<LoginPage dienst="cloudflare" robotSleutel="sleutel-van-de-site" />);
    await waitFor(() => expect(signInWithOAuth).toHaveBeenCalled());
    expect(document.head.querySelector('script[src*="turnstile"]')).not.toBeNull();
  });
});

describe("doel 6: de schakelaar voor de controle tegen robots", () => {
  function nepTurnstile() {
    const widgets: { callback: (token: string) => void }[] = [];
    const api: TurnstileApi = {
      render: (_vak, opties) => {
        widgets.push({ callback: opties.callback });
        return `widget-${widgets.length}`;
      },
      reset: vi.fn(),
      remove: vi.fn(),
    };
    return { api, widgets };
  }

  it("6.1 met de sleutel gezet gaat er toch een aanvraag zonder bewijs naar Supabase als de widget geen bewijs geeft", async () => {
    const { api } = nepTurnstile();
    window.turnstile = api;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<LoginPage dienst={KLANTPORTAAL} robotSleutel="sleutel-van-de-site" />);
    await userEvent.type(screen.getByLabelText("E-mailadres"), "piet@klant.nl");
    await userEvent.click(screen.getByRole("button", { name: "Doorgaan" }));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(signInWithOtp).toHaveBeenCalled();
  });

  it("6.2 klem: het script was geblokkeerd; ook als de blokkade weg is, komt er zonder verversen nooit meer een bewijs", async () => {
    let geblokkeerd = true;
    const { api, widgets } = nepTurnstile();
    const laad = vi.fn(() =>
      geblokkeerd ? Promise.reject(new Error("geblokkeerd")) : Promise.resolve(api),
    );
    const { result } = renderHook(() => useRobotcontrole("sleutel", laad, 50));
    const vak = document.createElement("div");
    result.current?.vak(vak);
    expect(await result.current?.haalToken()).toBeNull();
    // De klant zet zijn blokkeerder uit en klikt opnieuw op Doorgaan, zonder te verversen.
    geblokkeerd = false;
    const tweede = result.current?.haalToken();
    for (const widget of widgets) widget.callback("bewijs");
    expect(await tweede).toBeNull();
    expect(laad).toHaveBeenCalledTimes(1);
  });

  it("6.3 klem: een eerste klik zonder script kost de klant de volle wachttijd voordat er een melding komt", async () => {
    // Het script faalde al vóór de klik (blokkeerder). Wie daarna klikt, staat in de rij en
    // hoort pas na WACHT_OP_CONTROLE_MS (15 s) dat het niet lukt; "meteen" geldt alleen voor
    // wie al wachtte toen het laden mislukte.
    const laad = vi.fn(() => Promise.reject(new Error("geblokkeerd")));
    const { result } = renderHook(() => useRobotcontrole("sleutel", laad, 400));
    result.current?.vak(document.createElement("div"));
    await new Promise((klaar) => setTimeout(klaar, 20));
    const begin = Date.now();
    expect(await result.current?.haalToken()).toBeNull();
    expect(Date.now() - begin).toBeGreaterThanOrEqual(350);
  });

  it("6.4 een verlopen bewijs wordt toch nog meegestuurd", async () => {
    const opties: { verlopen?: () => void; callback?: (token: string) => void } = {};
    const api: TurnstileApi = {
      render: (_vak, o) => {
        opties.verlopen = o["expired-callback"];
        opties.callback = o.callback;
        return "widget-1";
      },
      reset: vi.fn(),
      remove: vi.fn(),
    };
    const { result } = renderHook(() => useRobotcontrole("sleutel", () => Promise.resolve(api), 50));
    result.current?.vak(document.createElement("div"));
    await waitFor(() => expect(opties.callback).toBeDefined());
    opties.callback?.("oud-bewijs");
    opties.verlopen?.();
    expect(await result.current?.haalToken()).toBe("oud-bewijs");
  });

  it("6.5 nieuwe code: 'Stuur een nieuwe code' gaat zonder bewijs of met het al gebruikte bewijs naar Supabase", async () => {
    const { api, widgets } = nepTurnstile();
    window.turnstile = api;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<LoginPage dienst={KLANTPORTAAL} robotSleutel="sleutel-van-de-site" />);
    await waitFor(() => expect(widgets.length).toBe(1));
    widgets[0]?.callback("bewijs-1");
    await userEvent.type(screen.getByLabelText("E-mailadres"), "piet@klant.nl");
    await userEvent.click(screen.getByRole("button", { name: "Doorgaan" }));
    await screen.findByLabelText("Code van acht cijfers");
    for (let seconde = 0; seconde < 63; seconde++) await vi.advanceTimersByTimeAsync(1000);
    await userEvent.click(await screen.findByRole("button", { name: "Stuur een nieuwe code" }));
    await vi.advanceTimersByTimeAsync(20_000);
    const tweede = signInWithOtp.mock.calls[1]?.[0] as
      | { options?: { captchaToken?: string } }
      | undefined;
    // Gelukt als er een tweede aanvraag is zonder bewijs of met het oude bewijs.
    expect(tweede).toBeDefined();
    expect([undefined, "bewijs-1"]).toContain(tweede?.options?.captchaToken);
  });
});
