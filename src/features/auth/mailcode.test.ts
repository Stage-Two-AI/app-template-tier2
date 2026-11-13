import { describe, expect, it, vi } from "vitest";
import {
  BEGIN,
  bewaar,
  CODE_GELDIG_MS,
  controleerCode,
  controleerLink,
  foutUitAdres,
  herstel,
  isHeleCode,
  leesAdres,
  leesCode,
  leesLink,
  type MailcodeAuth,
  type Toestand,
  volgende,
  vraagCode,
  WACHT_OPNIEUW_MS,
  wachtNog,
} from "./mailcode";

type Fout = { message: string; status?: number; code?: string; name?: string } | null;

function nepAuth(antwoord: { otp?: Fout; verify?: Fout } = {}) {
  return {
    signInWithOtp: vi.fn().mockResolvedValue({ data: {}, error: antwoord.otp ?? null }),
    verifyOtp: vi.fn().mockResolvedValue({ data: {}, error: antwoord.verify ?? null }),
  } satisfies MailcodeAuth;
}

const TERUG = "https://portaal.klant.nl/login";

describe("leesAdres en leesCode", () => {
  it("maakt een adres schoon: zonder spaties, in kleine letters", () => {
    expect(leesAdres("  Piet@Klant.NL ")).toBe("piet@klant.nl");
    expect(leesAdres("geen-adres")).toBeNull();
    expect(leesAdres("")).toBeNull();
  });

  it("houdt van een geplakte code alleen de zes cijfers over", () => {
    expect(leesCode("123 456")).toBe("123456");
    expect(leesCode("123-456\n")).toBe("123456");
    expect(leesCode("12345678")).toBe("123456");
    expect(leesCode("abc")).toBe("");
    expect(isHeleCode("123456")).toBe(true);
    expect(isHeleCode("12345")).toBe(false);
  });
});

describe("vraagCode", () => {
  it("vraagt Supabase om een mail naar het schone adres, terug naar de inlogpagina", async () => {
    const auth = nepAuth();
    expect(await vraagCode(auth, " Piet@Klant.nl ", TERUG)).toEqual({ ok: true });
    expect(auth.signInWithOtp).toHaveBeenCalledWith({
      email: "piet@klant.nl",
      options: { emailRedirectTo: TERUG, shouldCreateUser: true },
    });
  });

  it("stuurt het bewijs van de controle tegen robots mee als die aan staat", async () => {
    const auth = nepAuth();
    expect(await vraagCode(auth, "piet@klant.nl", TERUG, "bewijs-123")).toEqual({ ok: true });
    expect(auth.signInWithOtp).toHaveBeenCalledWith({
      email: "piet@klant.nl",
      options: { emailRedirectTo: TERUG, shouldCreateUser: true, captchaToken: "bewijs-123" },
    });
  });

  it("zegt het als Supabase de controle tegen robots afkeurt, in plaats van te doen alsof er een mail is", async () => {
    const auth = nepAuth({
      otp: {
        message: "captcha protection: request disallowed (no captcha_token found)",
        status: 400,
        code: "captcha_failed",
      },
    });
    const uitkomst = await vraagCode(auth, "piet@klant.nl", TERUG);
    expect(uitkomst).toMatchObject({ ok: false, fout: { soort: "robot" } });
    expect(uitkomst.ok ? "" : uitkomst.fout.tekst).not.toContain("captcha");
  });

  it("weigert een ongeldig adres zonder Supabase aan te roepen", async () => {
    const auth = nepAuth();
    const uitkomst = await vraagCode(auth, "geen-adres", TERUG);
    expect(uitkomst).toMatchObject({ ok: false, fout: { soort: "adres" } });
    expect(auth.signInWithOtp).not.toHaveBeenCalled();
  });

  it("geeft bij een geweigerd adres hetzelfde antwoord als bij een verstuurde mail", async () => {
    // Een onbekend adres, geen nieuwe accounts, een hook die nee zegt: de pagina mag niet
    // verraden wie een account heeft.
    const weigeringen: Fout[] = [
      { message: "Signups not allowed for otp", status: 422, code: "otp_disabled" },
      { message: "Signups not allowed for this instance", status: 422, code: "signup_disabled" },
      { message: "Geen toegang", status: 400, code: "hook_payload_invalid" },
      { message: "User is banned", status: 400, code: "user_banned" },
      { message: "Email address is invalid", status: 400, code: "email_address_invalid" },
    ];
    for (const otp of weigeringen) {
      expect(await vraagCode(nepAuth({ otp }), "piet@klant.nl", TERUG)).toEqual({ ok: true });
    }
  });

  it("zegt het wel bij te veel pogingen, geen verbinding of uitgeschakelde mail-inlog", async () => {
    const gevallen: [Fout, string][] = [
      [{ message: "rate limit", status: 429, code: "over_email_send_rate_limit" }, "te-vaak"],
      [{ message: "Failed to fetch", status: 0, name: "AuthRetryableFetchError" }, "verbinding"],
      [{ message: "boem", status: 500 }, "verbinding"],
      [{ message: "uit", status: 400, code: "email_provider_disabled" }, "uit"],
    ];
    for (const [otp, soort] of gevallen) {
      const uitkomst = await vraagCode(nepAuth({ otp }), "piet@klant.nl", TERUG);
      expect(uitkomst).toMatchObject({ ok: false, fout: { soort } });
    }
  });

  it("vangt een weggevallen verbinding op", async () => {
    const auth = nepAuth();
    auth.signInWithOtp.mockRejectedValue(new TypeError("Failed to fetch"));
    const uitkomst = await vraagCode(auth, "piet@klant.nl", TERUG);
    expect(uitkomst).toMatchObject({ ok: false, fout: { soort: "verbinding" } });
  });
});

describe("controleerCode", () => {
  const nu = 1_800_000_000_000;
  const vers = { verstuurdOp: nu - 60_000, nu };

  it("controleert de code als eenmalige e-mailcode", async () => {
    const auth = nepAuth();
    expect(await controleerCode(auth, "piet@klant.nl", "123 456", vers)).toEqual({ ok: true });
    expect(auth.verifyOtp).toHaveBeenCalledWith({
      email: "piet@klant.nl",
      token: "123456",
      type: "email",
    });
  });

  it("roept Supabase niet aan met een halve code", async () => {
    const auth = nepAuth();
    const uitkomst = await controleerCode(auth, "piet@klant.nl", "123", vers);
    expect(uitkomst).toMatchObject({ ok: false, fout: { soort: "code" } });
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });

  const afgewezen = {
    message: "Token has expired or is invalid",
    status: 403,
    code: "otp_expired",
  };

  it("zegt bij een foute code dat hij niet klopt", async () => {
    const uitkomst = await controleerCode(
      nepAuth({ verify: afgewezen }),
      "piet@klant.nl",
      "000000",
      vers,
    );
    expect(uitkomst).toMatchObject({ ok: false, fout: { soort: "code" } });
  });

  it("zegt na een kwartier dat de code verlopen is", async () => {
    const oud = { verstuurdOp: nu - CODE_GELDIG_MS - 1000, nu };
    const uitkomst = await controleerCode(
      nepAuth({ verify: afgewezen }),
      "piet@klant.nl",
      "123456",
      oud,
    );
    expect(uitkomst).toMatchObject({ ok: false, fout: { soort: "verlopen" } });
  });

  it("zegt het bij te veel pogingen", async () => {
    const verify = { message: "rate limit", status: 429, code: "over_request_rate_limit" };
    const uitkomst = await controleerCode(nepAuth({ verify }), "piet@klant.nl", "123456", vers);
    expect(uitkomst).toMatchObject({ ok: false, fout: { soort: "te-vaak" } });
  });
});

describe("de link uit de mail", () => {
  it("leest alleen een link van het type email", () => {
    expect(leesLink("?token_hash=pkce_abcdef0123456789&type=email")).toEqual({
      tokenHash: "pkce_abcdef0123456789",
    });
    // Geen andere soorten links via de inlogpagina: wachtwoord herstellen, adres wijzigen.
    for (const type of ["recovery", "email_change", "invite", "signup", "magiclink", ""]) {
      expect(leesLink(`?token_hash=abcdef0123456789abcd&type=${type}`)).toBeNull();
    }
    expect(leesLink("?token_hash=<script>&type=email")).toBeNull();
    expect(leesLink("?type=email")).toBeNull();
    expect(leesLink("")).toBeNull();
  });

  it("bevestigt de link bij Supabase", async () => {
    const auth = nepAuth();
    expect(await controleerLink(auth, "abcdef0123456789abcd")).toEqual({ ok: true });
    expect(auth.verifyOtp).toHaveBeenCalledWith({
      token_hash: "abcdef0123456789abcd",
      type: "email",
    });
  });

  it("zegt bij een gebruikte link dat er een nieuwe code nodig is", async () => {
    const verify = { message: "Email link is invalid or has expired", status: 403 };
    const uitkomst = await controleerLink(nepAuth({ verify }), "abcdef0123456789abcd");
    expect(uitkomst).toMatchObject({ ok: false, fout: { soort: "link" } });
  });
});

describe("foutUitAdres", () => {
  it("geeft niets zonder fout in het adres", () => {
    expect(foutUitAdres("", "")).toBeNull();
    expect(foutUitAdres("?code=abc", "")).toBeNull();
  });

  it("toont nooit de tekst uit het adres zelf", () => {
    const vreemd = "?error=access_denied&error_description=Bel+0900-1234+voor+je+code";
    const uitkomst = foutUitAdres(vreemd, "");
    expect(uitkomst?.tekst).toBe("Inloggen is niet gelukt. Probeer het opnieuw.");
    expect(foutUitAdres("", "#error_description=Bel+0900")?.tekst).not.toContain("0900");
  });

  it("legt uit wat een nieuwe medewerker moet doen na 'Unverified email' van Supabase", () => {
    // Zo komt Supabase terug na de knop voor medewerkers (internal/api/external.go).
    const terug =
      "?error=access_denied&error_code=provider_email_needs_verification&error_description=Unverified+email+with+custom%3Acloudflare.+A+confirmation+email+has+been+sent+to+your+custom%3Acloudflare+email";
    for (const uitkomst of [foutUitAdres(terug, ""), foutUitAdres("", `#${terug.slice(1)}`)]) {
      expect(uitkomst?.soort).toBe("bevestig-adres");
      expect(uitkomst?.tekst).toContain("klik op de link in die mail");
      expect(uitkomst?.tekst).toContain("Inloggen voor medewerkers");
      expect(uitkomst?.tekst).not.toMatch(/unverified|custom:cloudflare|confirmation/i);
    }
  });

  it("zegt bij 'Unverified email' zonder mail dat de beheerder het moet oplossen", () => {
    const terug =
      "?error=access_denied&error_code=provider_email_needs_verification&error_description=Unverified+email+with+custom%3Acloudflare.+Verify+the+email+with+custom%3Acloudflare+in+order+to+sign+in";
    const uitkomst = foutUitAdres(terug, "");
    expect(uitkomst?.soort).toBe("adres-bezet");
    expect(uitkomst?.tekst).toContain("Vraag je beheerder");
    expect(uitkomst?.tekst).not.toMatch(/unverified|custom:cloudflare|verify/i);
  });

  it("herkent de weigering ook zonder foutcode, en neemt de tekst nooit over", () => {
    const uitkomst = foutUitAdres(
      "?error=access_denied&error_description=Unverified+email+with+custom%3Acloudflare.+Bel+0900-1234",
      "",
    );
    expect(uitkomst?.soort).toBe("adres-bezet");
    expect(uitkomst?.tekst).not.toContain("0900");
  });

  it("herkent een verlopen link", () => {
    expect(foutUitAdres("?error=access_denied&error_code=otp_expired", "")?.tekst).toContain(
      "verlopen",
    );
  });
});

describe("de toestand van het formulier", () => {
  const nu = 1_800_000_000_000;

  it("gaat na het versturen naar de codestap en onthoudt adres en tijd", () => {
    const bezig = volgende(BEGIN, { soort: "bezig", waarmee: "versturen" });
    expect(bezig.bezig).toBe("versturen");
    const code = volgende(bezig, {
      soort: "verstuurd",
      email: "piet@klant.nl",
      op: nu,
      opnieuw: false,
    });
    expect(code).toMatchObject({ stap: "code", email: "piet@klant.nl", verstuurdOp: nu });
    expect(code.bezig).toBeNull();
    expect(code.melding).toBeNull();
  });

  it("meldt een nieuwe code en wist de oude fout", () => {
    const metFout: Toestand = {
      ...BEGIN,
      stap: "code",
      email: "piet@klant.nl",
      verstuurdOp: nu,
      fout: { soort: "code", tekst: "x" },
    };
    const opnieuw = volgende(metFout, {
      soort: "verstuurd",
      email: "piet@klant.nl",
      op: nu + 70_000,
      opnieuw: true,
    });
    expect(opnieuw.fout).toBeNull();
    expect(opnieuw.melding).toContain("nieuwe code");
    expect(opnieuw.verstuurdOp).toBe(nu + 70_000);
  });

  it("blijft bij een fout op dezelfde stap", () => {
    const code: Toestand = { ...BEGIN, stap: "code", email: "piet@klant.nl", verstuurdOp: nu };
    const mislukt = volgende(code, { soort: "mislukt", fout: { soort: "code", tekst: "x" } });
    expect(mislukt.stap).toBe("code");
    expect(mislukt.fout?.soort).toBe("code");
  });

  it("gaat met 'ander adres' terug, met het oude adres nog ingevuld", () => {
    const code: Toestand = { ...BEGIN, stap: "code", email: "piet@klant.nl", verstuurdOp: nu };
    expect(volgende(code, { soort: "ander-adres" })).toEqual({ ...BEGIN, email: "piet@klant.nl" });
  });

  it("telt de wachttijd voor een nieuwe code af", () => {
    expect(wachtNog(null, nu)).toBe(0);
    expect(wachtNog(nu, nu)).toBe(WACHT_OPNIEUW_MS / 1000);
    expect(wachtNog(nu, nu + 59_500)).toBe(1);
    expect(wachtNog(nu, nu + WACHT_OPNIEUW_MS)).toBe(0);
  });
});

describe("onthouden tijdens het wisselen naar de mail-app", () => {
  const nu = 1_800_000_000_000;

  function nepOpslag() {
    const inhoud = new Map<string, string>();
    return {
      inhoud,
      getItem: (sleutel: string) => inhoud.get(sleutel) ?? null,
      setItem: (sleutel: string, waarde: string) => void inhoud.set(sleutel, waarde),
      removeItem: (sleutel: string) => void inhoud.delete(sleutel),
    };
  }

  it("komt na opnieuw laden terug op de codestap, zonder de code te bewaren", () => {
    const opslag = nepOpslag();
    bewaar(opslag, { ...BEGIN, stap: "code", email: "piet@klant.nl", verstuurdOp: nu });
    const bewaard: unknown = JSON.parse(opslag.getItem("inlogcode") ?? "{}");
    expect(Object.keys(bewaard as object).sort()).toEqual(["email", "verstuurdOp"]);
    expect(herstel(opslag, nu + 120_000)).toMatchObject({
      stap: "code",
      email: "piet@klant.nl",
      verstuurdOp: nu,
    });
  });

  it("begint opnieuw als de code verlopen is of er niets bruikbaars staat", () => {
    const opslag = nepOpslag();
    bewaar(opslag, { ...BEGIN, stap: "code", email: "piet@klant.nl", verstuurdOp: nu });
    expect(herstel(opslag, nu + CODE_GELDIG_MS + 1)).toEqual(BEGIN);
    opslag.setItem("inlogcode", "{kapot");
    expect(herstel(opslag, nu)).toEqual(BEGIN);
    opslag.setItem("inlogcode", JSON.stringify({ email: "<script>", verstuurdOp: nu }));
    expect(herstel(opslag, nu)).toEqual(BEGIN);
  });

  it("ruimt op zodra de codestap voorbij is", () => {
    const opslag = nepOpslag();
    bewaar(opslag, { ...BEGIN, stap: "code", email: "piet@klant.nl", verstuurdOp: nu });
    bewaar(opslag, BEGIN);
    expect(opslag.inhoud.size).toBe(0);
  });
});
