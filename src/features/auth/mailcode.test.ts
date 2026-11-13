import { describe, expect, it, vi } from "vitest";
import {
  BEGIN,
  bewaar,
  CODE_GELDIG_MS,
  controleerCode,
  controleerLink,
  foutUitAdres,
  herstel,
  isDienstInlogBegonnen,
  isHeleCode,
  isHierAangevraagd,
  leesAdres,
  leesCode,
  leesLink,
  type MailcodeAuth,
  merkAangevraagd,
  merkDienstInlog,
  ONTHOUD_ADRES_MS,
  type Toestand,
  volgende,
  vraagCode,
  WACHT_OPNIEUW_MS,
  wachtNog,
  wisAangevraagd,
  wisDienstInlog,
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

  it("houdt van een geplakte code alleen de acht cijfers over", () => {
    expect(leesCode("1234 5678")).toBe("12345678");
    expect(leesCode("1234-5678\n")).toBe("12345678");
    expect(leesCode("1234567890")).toBe("12345678");
    expect(leesCode("abc")).toBe("");
    expect(isHeleCode("12345678")).toBe(true);
    expect(isHeleCode("123456")).toBe(false);
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
      [{ message: "Failed to fetch", name: "AuthRetryableFetchError" }, "verbinding"],
      [{ message: "uit", status: 400, code: "email_provider_disabled" }, "uit"],
    ];
    for (const [otp, soort] of gevallen) {
      const uitkomst = await vraagCode(nepAuth({ otp }), "piet@klant.nl", TERUG);
      expect(uitkomst).toMatchObject({ ok: false, fout: { soort } });
    }
  });

  it("een antwoord met een storing (5xx) ziet er hetzelfde uit als een verstuurde mail", async () => {
    // Een hook van de inrichting die één adres weigert, komt bij Supabase soms terug als
    // storing. Zou de pagina dan "geen verbinding" zeggen, dan is aan dat adres iets te zien.
    for (const otp of [
      { message: "weigering", status: 500, code: "hook_failed" },
      { message: "boem", status: 500 },
      { message: "bad gateway", status: 502, name: "AuthRetryableFetchError" },
      { message: "time-out", status: 504, code: "hook_timeout" },
    ]) {
      expect(await vraagCode(nepAuth({ otp }), "medewerker@bedrijf.nl", TERUG)).toEqual({
        ok: true,
      });
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
    expect(await controleerCode(auth, "piet@klant.nl", "1234 5678", vers)).toEqual({ ok: true });
    expect(auth.verifyOtp).toHaveBeenCalledWith({
      email: "piet@klant.nl",
      token: "12345678",
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
      "00000000",
      vers,
    );
    expect(uitkomst).toMatchObject({ ok: false, fout: { soort: "code" } });
  });

  it("zegt na een kwartier dat de code verlopen is", async () => {
    const oud = { verstuurdOp: nu - CODE_GELDIG_MS - 1000, nu };
    const uitkomst = await controleerCode(
      nepAuth({ verify: afgewezen }),
      "piet@klant.nl",
      "12345678",
      oud,
    );
    expect(uitkomst).toMatchObject({ ok: false, fout: { soort: "verlopen" } });
  });

  it("zegt bij een storing niet dat de code fout is", async () => {
    const verify = { message: "boem", status: 500 };
    const uitkomst = await controleerCode(nepAuth({ verify }), "piet@klant.nl", "12345678", vers);
    expect(uitkomst).toMatchObject({ ok: false, fout: { soort: "dienst" } });
  });

  it("zegt het bij te veel pogingen", async () => {
    const verify = { message: "rate limit", status: 429, code: "over_request_rate_limit" };
    const uitkomst = await controleerCode(nepAuth({ verify }), "piet@klant.nl", "12345678", vers);
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

  const ONBEVESTIGD =
    "?error=access_denied&error_code=provider_email_needs_verification&error_description=Unverified+email+with+custom%3Acloudflare.+A+confirmation+email+has+been+sent+to+your+custom%3Acloudflare+email";
  const BEZET =
    "?error=access_denied&error_code=provider_email_needs_verification&error_description=Unverified+email+with+custom%3Acloudflare.+Verify+the+email+with+custom%3Acloudflare+in+order+to+sign+in";

  it("legt uit wat een nieuwe medewerker moet doen na 'Unverified email' van Supabase", () => {
    // Zo komt Supabase terug na de knop voor medewerkers (internal/api/external.go).
    for (const uitkomst of [
      foutUitAdres(ONBEVESTIGD, "", true),
      foutUitAdres("", `#${ONBEVESTIGD.slice(1)}`, true),
    ]) {
      expect(uitkomst?.soort).toBe("bevestig-adres");
      expect(uitkomst?.tekst).toContain("klik op de link in die mail");
      expect(uitkomst?.tekst).toContain("Inloggen voor medewerkers");
      expect(uitkomst?.tekst).not.toMatch(/unverified|custom:cloudflare|confirmation/i);
    }
  });

  it("zegt bij 'Unverified email' zonder mail eerlijk wat er is en wat de beheerder moet doen", () => {
    const uitkomst = foutUitAdres(BEZET, "", true);
    expect(uitkomst?.soort).toBe("adres-bezet");
    expect(uitkomst?.tekst).toContain("bestaat al een account dat nog niet bevestigd is");
    expect(uitkomst?.tekst).toContain(
      "Vraag je beheerder om dat account in Supabase (Authentication, Users) te bevestigen of te verwijderen",
    );
    expect(uitkomst?.tekst).not.toMatch(/unverified|custom:cloudflare|verify/i);
  });

  it("herkent de weigering ook zonder foutcode, en neemt de tekst nooit over", () => {
    const uitkomst = foutUitAdres(
      "?error=access_denied&error_description=Unverified+email+with+custom%3Acloudflare.+Bel+0900-1234",
      "",
      true,
    );
    expect(uitkomst?.soort).toBe("adres-bezet");
    expect(uitkomst?.tekst).not.toContain("0900");
  });

  it("geeft die uitleg alleen als deze browser de inlog zelf begon; een link van een ander kiest geen melding", () => {
    // Een vreemde vraagt een code aan op het adres van het slachtoffer (dat krijgt een echte
    // inlogmail) en stuurt daarna deze link. Zonder eigen poging zegt de pagina niets over
    // "klik op de link in die mail".
    for (const adres of [ONBEVESTIGD, BEZET]) {
      for (const uitkomst of [foutUitAdres(adres, ""), foutUitAdres(adres, "", false)]) {
        expect(uitkomst?.soort).toBe("dienst");
        expect(uitkomst?.tekst).toBe("Inloggen is niet gelukt. Probeer het opnieuw.");
      }
    }
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

  it("onthoudt het adres vijf minuten, niet zo lang als de code geldig is", () => {
    // Op een gedeelde computer ziet de volgende het adres van de vorige anders een kwartier.
    const opslag = nepOpslag();
    bewaar(opslag, { ...BEGIN, stap: "code", email: "piet@klant.nl", verstuurdOp: nu });
    expect(ONTHOUD_ADRES_MS).toBe(5 * 60 * 1000);
    expect(ONTHOUD_ADRES_MS).toBeLessThan(CODE_GELDIG_MS);
    expect(herstel(opslag, nu + ONTHOUD_ADRES_MS).stap).toBe("code");
    expect(herstel(opslag, nu + ONTHOUD_ADRES_MS + 1)).toEqual(BEGIN);
    // Een tijdstip in de toekomst (een verzette klok, of zelf ingevuld) telt niet.
    expect(herstel(opslag, nu - 1)).toEqual(BEGIN);
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

  it("onthoudt dat deze browser een code aanvroeg: alleen het tijdstip, een kwartier lang", () => {
    const opslag = nepOpslag();
    expect(isHierAangevraagd(opslag, nu)).toBe(false);
    merkAangevraagd(opslag, nu);
    expect([...opslag.inhoud.values()]).toEqual([String(nu)]);
    expect(isHierAangevraagd(opslag, nu + CODE_GELDIG_MS)).toBe(true);
    expect(isHierAangevraagd(opslag, nu + CODE_GELDIG_MS + 1)).toBe(false);
    expect(isHierAangevraagd(opslag, nu - 1)).toBe(false);
    wisAangevraagd(opslag);
    expect(opslag.inhoud.size).toBe(0);
    opslag.setItem("inlogcode-aangevraagd", "geen getal");
    expect(isHierAangevraagd(opslag, nu)).toBe(false);
  });

  it("onthoudt dat dit tabblad naar de inlogdienst ging, los van de aanvraag van een code", () => {
    const opslag = nepOpslag();
    expect(isDienstInlogBegonnen(opslag, nu)).toBe(false);
    merkDienstInlog(opslag, nu);
    expect(isDienstInlogBegonnen(opslag, nu + 60_000)).toBe(true);
    expect(isHierAangevraagd(opslag, nu + 60_000)).toBe(false);
    expect(isDienstInlogBegonnen(opslag, nu + CODE_GELDIG_MS + 1)).toBe(false);
    wisDienstInlog(opslag);
    expect(isDienstInlogBegonnen(opslag, nu)).toBe(false);
  });

  it("werkt ook zonder opslag: dan is niets hier begonnen", () => {
    const kapot = {
      getItem: () => {
        throw new Error("geen opslag");
      },
      setItem: () => {
        throw new Error("geen opslag");
      },
      removeItem: () => {
        throw new Error("geen opslag");
      },
    };
    merkAangevraagd(kapot, nu);
    merkDienstInlog(kapot, nu);
    wisAangevraagd(kapot);
    expect(isHierAangevraagd(kapot, nu)).toBe(false);
    expect(isDienstInlogBegonnen(kapot, nu)).toBe(false);
  });
});
