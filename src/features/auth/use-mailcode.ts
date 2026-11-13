import { useCallback, useEffect, useReducer, useState } from "react";
import {
  BEGIN,
  bewaar,
  controleerCode,
  controleerLink,
  fout,
  foutUitAdres,
  herstel,
  isDienstInlogBegonnen,
  isHierAangevraagd,
  leesAdres,
  leesLink,
  type MailcodeAuth,
  merkAangevraagd,
  type Toestand,
  volgende,
  vraagCode,
  wachtNog,
  wisAangevraagd,
} from "@/features/auth/mailcode";

/**
 * De koppeling tussen de stappen uit mailcode.ts en een pagina in de browser: de toestand,
 * de klok voor "nieuwe code" en het onthouden bij het wisselen naar de mail-app. Alle
 * regels staan in mailcode.ts; hier staat alleen wat een browser nodig heeft.
 */
export type Mailcode = {
  toestand: Toestand;
  /** Seconden tot "nieuwe code" weer mag; nul als het mag. */
  wachtNog: number;
  verstuur: (adres: string) => Promise<void>;
  controleer: (code: string) => Promise<void>;
  opnieuw: () => Promise<void>;
  anderAdres: () => void;
  bevestigLink: () => Promise<void>;
  /**
   * Alleen van belang op de stap `link`: heeft deze browser de mail zelf net aangevraagd?
   * Zo niet, dan waarschuwt de pagina vóór de knop.
   */
  linkHierAangevraagd: boolean;
};

function opslag(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Gedeeld door de tabbladen van deze browser; zie `merkAangevraagd` in mailcode.ts. */
function gedeeldeOpslag(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

type Begin = { toestand: Toestand; tokenHash: string | null; linkHierAangevraagd: boolean };

function beginToestand(): Begin {
  const nu = Date.now();
  const kluis = opslag();
  const link = leesLink(window.location.search);
  if (link) {
    const gedeeld = gedeeldeOpslag();
    return {
      toestand: { ...BEGIN, stap: "link" },
      tokenHash: link.tokenHash,
      linkHierAangevraagd: gedeeld !== null && isHierAangevraagd(gedeeld, nu),
    };
  }
  const zelfBegonnen = kluis !== null && isDienstInlogBegonnen(kluis, nu);
  const uitAdres = foutUitAdres(window.location.search, window.location.hash, zelfBegonnen);
  if (uitAdres) {
    return { toestand: { ...BEGIN, fout: uitAdres }, tokenHash: null, linkHierAangevraagd: false };
  }
  return {
    toestand: kluis ? herstel(kluis, nu) : BEGIN,
    tokenHash: null,
    linkHierAangevraagd: false,
  };
}

/** Haalt de eenmalige link of de fout uit de adresbalk, zodat verversen niets herhaalt. */
function maakAdresSchoon(): void {
  window.history.replaceState(null, "", window.location.pathname);
}

/**
 * De controle tegen robots, als die aan staat (robotcontrole.tsx). `haalToken` geeft het
 * bewijs voor één aanvraag, of null als de controle niet lukte; `verbruikt` vraagt daarna
 * een nieuw bewijs aan, want elk bewijs werkt één keer.
 */
export type Robot = { haalToken: () => Promise<string | null>; verbruikt: () => void };

export function useMailcode(
  auth: MailcodeAuth,
  terugNaar: () => string,
  robot: Robot | null = null,
): Mailcode {
  const [begin] = useState(beginToestand);
  const [toestand, stuur] = useReducer(volgende, begin.toestand);
  const [nu, setNu] = useState(() => Date.now());

  useEffect(() => {
    const kluis = opslag();
    if (kluis && toestand.stap !== "link") bewaar(kluis, toestand);
  }, [toestand]);

  const rest = toestand.stap === "code" ? wachtNog(toestand.verstuurdOp, nu) : 0;
  useEffect(() => {
    if (rest === 0) return;
    const klok = window.setTimeout(() => setNu(Date.now()), 1000);
    return () => window.clearTimeout(klok);
  }, [rest]);

  const stuurCode = useCallback(
    async (adres: string, opnieuw: boolean) => {
      stuur({ soort: "bezig", waarmee: opnieuw ? "opnieuw" : "versturen" });
      let bewijs: string | undefined;
      if (robot) {
        // Eerst het adres: een tikfout hoeft niet op de controle te wachten.
        if (!leesAdres(adres)) {
          stuur({ soort: "mislukt", fout: fout("adres") });
          return;
        }
        const token = await robot.haalToken();
        if (!token) {
          stuur({ soort: "mislukt", fout: fout("robot") });
          return;
        }
        bewijs = token;
      }
      const uitkomst = await vraagCode(auth, adres, terugNaar(), bewijs);
      robot?.verbruikt();
      const op = Date.now();
      setNu(op);
      if (uitkomst.ok) {
        const gedeeld = gedeeldeOpslag();
        if (gedeeld) merkAangevraagd(gedeeld, op);
        stuur({ soort: "verstuurd", email: leesAdres(adres) ?? adres, op, opnieuw });
      } else {
        stuur({ soort: "mislukt", fout: uitkomst.fout });
      }
    },
    [auth, terugNaar, robot],
  );

  const verstuur = useCallback((adres: string) => stuurCode(adres, false), [stuurCode]);

  const opnieuw = useCallback(async () => {
    if (wachtNog(toestand.verstuurdOp, Date.now()) > 0) return;
    await stuurCode(toestand.email, true);
  }, [stuurCode, toestand.email, toestand.verstuurdOp]);

  const controleer = useCallback(
    async (code: string) => {
      stuur({ soort: "bezig", waarmee: "controleren" });
      const uitkomst = await controleerCode(auth, toestand.email, code, {
        verstuurdOp: toestand.verstuurdOp,
        nu: Date.now(),
      });
      // Gelukt: Supabase meldt de sessie zelf (use-session.ts) en de app stuurt door. De
      // pagina blijft tot dat moment op "bezig" staan.
      if (uitkomst.ok) {
        // Ingelogd: het tabblad onthoudt het adres niet langer.
        const kluis = opslag();
        if (kluis) bewaar(kluis, BEGIN);
        const gedeeld = gedeeldeOpslag();
        if (gedeeld) wisAangevraagd(gedeeld);
      } else {
        stuur({ soort: "mislukt", fout: uitkomst.fout });
      }
    },
    [auth, toestand.email, toestand.verstuurdOp],
  );

  const anderAdres = useCallback(() => stuur({ soort: "ander-adres" }), []);

  const bevestigLink = useCallback(async () => {
    if (!begin.tokenHash) return;
    stuur({ soort: "bezig", waarmee: "controleren" });
    const uitkomst = await controleerLink(auth, begin.tokenHash);
    if (uitkomst.ok) {
      const gedeeld = gedeeldeOpslag();
      if (gedeeld) wisAangevraagd(gedeeld);
    } else {
      maakAdresSchoon();
      stuur({ soort: "link-mislukt", fout: uitkomst.fout });
    }
  }, [auth, begin.tokenHash]);

  useEffect(() => {
    // Een fout uit het adres is nu in beeld; haal hem uit de adresbalk.
    if (begin.toestand.fout) maakAdresSchoon();
  }, [begin.toestand.fout]);

  return {
    toestand,
    wachtNog: rest,
    verstuur,
    controleer,
    opnieuw,
    anderAdres,
    bevestigLink,
    linkHierAangevraagd: begin.linkHierAangevraagd,
  };
}
