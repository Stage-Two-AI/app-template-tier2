import { afterEach, describe, expect, it } from "vitest";
import {
  bepaalOntvangers,
  isProductie,
  mailOmgeving,
  richtMail,
} from "../../supabase/functions/_shared/mail";

const MAIL = {
  aan: ["klant@voorbeeld.nl"],
  cc: "collega@voorbeeld.nl",
  bcc: ["archief@voorbeeld.nl"],
  onderwerp: "Je bestelling",
  tekst: "Hallo",
};

describe("testmail in de Edge Functions", () => {
  it("in productie (OMGEVING leeg of productie) blijft de mail zoals hij is", () => {
    for (const omgeving of [undefined, null, "", "  ", "productie", "Productie"]) {
      expect(bepaalOntvangers(MAIL, { omgeving, testmailAdres: "test@stagetwo.nl" })).toBe(MAIL);
    }
    expect(isProductie("test")).toBe(false);
  });

  it("buiten productie gaat hij alleen naar het testadres, met [test] voor het onderwerp", () => {
    const uit = bepaalOntvangers(MAIL, { omgeving: "test", testmailAdres: " test@stagetwo.nl " });
    expect(uit).toEqual({
      aan: ["test@stagetwo.nl"],
      onderwerp: "[test] Je bestelling",
      tekst: "Hallo",
    });
    expect(uit).not.toHaveProperty("cc");
    expect(uit).not.toHaveProperty("bcc");
    // Het origineel blijft onaangeroerd.
    expect(MAIL.aan).toEqual(["klant@voorbeeld.nl"]);
  });

  it("geen dubbel [test] als het onderwerp het al heeft", () => {
    const uit = bepaalOntvangers(
      { aan: "a@b.nl", onderwerp: "[test] Herinnering" },
      { omgeving: "lokaal", testmailAdres: "test@stagetwo.nl" },
    );
    expect(uit?.onderwerp).toBe("[test] Herinnering");
  });

  it("buiten productie zonder testadres: niet versturen", () => {
    expect(bepaalOntvangers(MAIL, { omgeving: "test" })).toBeNull();
    expect(bepaalOntvangers(MAIL, { omgeving: "test", testmailAdres: "  " })).toBeNull();
  });
});

describe("de omgeving van de functie (Deno.env)", () => {
  const g = globalThis as { Deno?: unknown };
  afterEach(() => {
    delete g.Deno;
  });

  it("leest OMGEVING en TESTMAIL_ADRES uit Deno.env", () => {
    const waarden: Record<string, string> = {
      OMGEVING: "test",
      TESTMAIL_ADRES: "test@stagetwo.nl",
    };
    g.Deno = { env: { get: (naam: string) => waarden[naam] } };
    expect(mailOmgeving()).toEqual({ omgeving: "test", testmailAdres: "test@stagetwo.nl" });
    expect(richtMail({ aan: "klant@voorbeeld.nl", onderwerp: "Hoi" })).toEqual({
      aan: ["test@stagetwo.nl"],
      onderwerp: "[test] Hoi",
    });
  });

  it("zonder Deno (of zonder secrets) telt het als productie", () => {
    expect(mailOmgeving()).toEqual({ omgeving: null, testmailAdres: null });
    const mail = { aan: "klant@voorbeeld.nl", onderwerp: "Hoi" };
    expect(richtMail(mail)).toBe(mail);
  });
});
