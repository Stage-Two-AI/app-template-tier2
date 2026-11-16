import { useCallback, useMemo, useRef } from "react";

/**
 * De controle tegen robots op het inlogformulier voor klanten: Cloudflare Turnstile. Een
 * schakelaar: zonder `VITE_TURNSTILE_SITEKEY` gebeurt hier niets, wordt er geen script
 * geladen en verandert er niets aan de pagina.
 *
 * Waarom: een open inlogformulier kan door een script worden gebruikt om duizenden mails te
 * laten versturen. De inrichting kan daarom bij Supabase de controle aanzetten
 * (`security_captcha_enabled`). Vanaf dat moment weigert Supabase elke aanvraag van een code
 * zonder bewijs van deze controle. De sleutel hier en de schakelaar bij Supabase horen dus
 * bij elkaar: staat de controle bij Supabase aan en ontbreekt de sleutel hier, dan kan geen
 * klant meer inloggen.
 *
 * De sleutel is openbaar (hij staat toch in de pagina); het geheim dat erbij hoort staat
 * alleen bij Supabase.
 *
 * De widget is meestal onzichtbaar (`interaction-only`): alleen wie Cloudflare niet
 * vertrouwt, krijgt een vakje om aan te vinken. Elk bewijs werkt één keer en vijf minuten;
 * na elke aanvraag vraagt `verbruikt` een nieuw aan.
 */
const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** Zo lang wacht een klik op "Doorgaan" op de controle voordat de pagina zegt dat het niet lukt. */
export const WACHT_OP_CONTROLE_MS = 15_000;

type WidgetOpties = {
  sitekey: string;
  callback: (token: string) => void;
  "expired-callback": () => void;
  "error-callback": () => boolean;
  appearance: "always" | "execute" | "interaction-only";
  size: "normal" | "flexible" | "compact";
  action: string;
};

/** Het deel van Turnstile dat hier nodig is (challenges.cloudflare.com/turnstile/v0/api.js). */
export type TurnstileApi = {
  render: (vak: HTMLElement, opties: WidgetOpties) => string | null | undefined;
  reset: (widget: string) => void;
  remove: (widget: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let bezigMetLaden: Promise<TurnstileApi> | null = null;

/** Laadt het script van Cloudflare, één keer. Alleen aangeroepen als de sleutel gezet is. */
export function laadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  bezigMetLaden ??= new Promise<TurnstileApi>((klaar, mislukt) => {
    const script = document.createElement("script");
    script.src = SCRIPT;
    script.async = true;
    script.onload = () => {
      if (window.turnstile) klaar(window.turnstile);
      else mislukt(new Error("Het script van Turnstile is geladen maar doet niets."));
    };
    script.onerror = () => {
      // Volgende keer opnieuw proberen (bijvoorbeeld na het uitzetten van een blokkeerder).
      bezigMetLaden = null;
      script.remove();
      mislukt(new Error("Het script van Turnstile kon niet geladen worden."));
    };
    document.head.appendChild(script);
  });
  return bezigMetLaden;
}

export type Robotcontrole = {
  /** Zet dit als `ref` op een lege div in het formulier; daar komt de widget. */
  vak: (element: HTMLDivElement | null) => (() => void) | undefined;
  /** Het bewijs voor één aanvraag. Wacht zo nodig op de controle; null als het niet lukt. */
  haalToken: () => Promise<string | null>;
  /** Het bewijs is gebruikt: vraag een nieuw aan voor de volgende aanvraag. */
  verbruikt: () => void;
};

/**
 * Geeft null zonder sleutel: dan staat de controle uit. Met sleutel: de widget in `vak` en
 * het bewijs via `haalToken`.
 *
 * Laden kan mislukken (een blokkeerder, geen verbinding). Dan zegt `haalToken` dat meteen, en
 * probeert elke volgende klik het laden opnieuw: wie zijn blokkeerder uitzet, hoeft de pagina
 * niet te verversen.
 */
export function useRobotcontrole(
  sitekey: string | undefined,
  laad: () => Promise<TurnstileApi> = laadTurnstile,
  wachtMs: number = WACHT_OP_CONTROLE_MS,
): Robotcontrole | null {
  const token = useRef<string | null>(null);
  const wachters = useRef<((token: string | null) => void)[]>([]);
  const widget = useRef<{ api: TurnstileApi; id: string } | null>(null);
  const element = useRef<HTMLDivElement | null>(null);
  /** De lopende of laatste poging om de widget neer te zetten; `mislukt` als die niet lukte. */
  const poging = useRef<{ klaar: Promise<boolean>; mislukt: boolean } | null>(null);

  const meld = useCallback((nieuw: string | null) => {
    token.current = nieuw;
    if (nieuw === null) return;
    for (const wachter of wachters.current.splice(0)) wachter(nieuw);
  }, []);

  /** Laadt het script en zet de widget in het vak. Geeft false als dat niet lukt. */
  const zetNeer = useCallback((): Promise<boolean> => {
    const doel = element.current;
    if (!doel || !sitekey) return Promise.resolve(false);
    const deze: { klaar: Promise<boolean>; mislukt: boolean } = {
      mislukt: false,
      klaar: laad()
        .then((api) => {
          // Het vak is intussen weg of vervangen: deze poging telt niet meer.
          if (element.current !== doel || poging.current !== deze) return false;
          const id = api.render(doel, {
            sitekey,
            callback: (nieuw) => meld(nieuw),
            "expired-callback": () => meld(null),
            // Turnstile probeert het zelf opnieuw; `true` zegt dat de fout hier is opgevangen.
            "error-callback": () => {
              meld(null);
              return true;
            },
            appearance: "interaction-only",
            size: "flexible",
            action: "inlogcode",
          });
          if (!id) throw new Error("Turnstile zette geen widget neer.");
          widget.current = { api, id };
          return true;
        })
        .catch(() => {
          deze.mislukt = true;
          // Geen widget: wie wacht, hoort meteen dat het niet lukt.
          if (poging.current === deze) {
            for (const wachter of wachters.current.splice(0)) wachter(null);
          }
          return false;
        }),
    };
    poging.current = deze;
    return deze.klaar;
  }, [sitekey, laad, meld]);

  const vak = useCallback(
    (nieuw: HTMLDivElement | null) => {
      if (!nieuw || !sitekey) return undefined;
      element.current = nieuw;
      void zetNeer();
      return () => {
        if (element.current === nieuw) element.current = null;
        poging.current = null;
        token.current = null;
        const huidige = widget.current;
        widget.current = null;
        try {
          if (huidige) huidige.api.remove(huidige.id);
        } catch {
          // De widget was al weg.
        }
      };
    },
    [sitekey, zetNeer],
  );

  const haalToken = useCallback(async (): Promise<string | null> => {
    if (token.current) return token.current;
    // Was het laden al mislukt, probeer het dan nu opnieuw; lukt het weer niet, dan weet de
    // gebruiker dat meteen en niet pas na de hele wachttijd.
    if (poging.current?.mislukt && !(await zetNeer())) return null;
    if (token.current) return token.current;
    return new Promise((klaar) => {
      const wachter = (nieuw: string | null) => {
        window.clearTimeout(klok);
        klaar(nieuw);
      };
      const klok = window.setTimeout(() => {
        wachters.current = wachters.current.filter((andere) => andere !== wachter);
        klaar(null);
      }, wachtMs);
      wachters.current.push(wachter);
    });
  }, [wachtMs, zetNeer]);

  const verbruikt = useCallback(() => {
    token.current = null;
    try {
      if (widget.current) widget.current.api.reset(widget.current.id);
    } catch {
      // Lukt een nieuw bewijs niet, dan merkt de volgende aanvraag dat (haalToken geeft null).
    }
  }, []);

  const controle = useMemo(() => ({ vak, haalToken, verbruikt }), [vak, haalToken, verbruikt]);
  return sitekey ? controle : null;
}
