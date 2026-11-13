import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type TurnstileApi, useRobotcontrole } from "./robotcontrole";

/**
 * De controle tegen robots als het laden van Turnstile niet lukt (een blokkeerder, geen
 * verbinding). De klant mag daar niet in vast komen te zitten. Hoe de pagina het bewijs
 * gebruikt, staat in inlog-met-code.test.tsx.
 */
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

describe("useRobotcontrole", () => {
  it("zonder sleutel staat de controle uit", () => {
    const laad = vi.fn();
    const { result } = renderHook(() => useRobotcontrole(undefined, laad));
    expect(result.current).toBeNull();
    expect(laad).not.toHaveBeenCalled();
  });

  it("zegt meteen dat het niet lukt als het laden al mislukt was, zonder de hele wachttijd", async () => {
    const laad = vi.fn(() => Promise.reject(new Error("geblokkeerd")));
    const { result } = renderHook(() => useRobotcontrole("sleutel", laad, 5000));
    result.current?.vak(document.createElement("div"));
    await waitFor(() => expect(laad).toHaveBeenCalledTimes(1));
    await new Promise((klaar) => setTimeout(klaar, 10));

    const begin = Date.now();
    expect(await result.current?.haalToken()).toBeNull();
    expect(Date.now() - begin).toBeLessThan(1000);
    // Elke klik probeert het laden opnieuw.
    expect(laad).toHaveBeenCalledTimes(2);
  });

  it("zegt het ook meteen aan wie al wachtte toen het laden mislukte", async () => {
    let mislukt: (fout: Error) => void = () => {};
    const laad = vi.fn(
      () =>
        new Promise<TurnstileApi>((_, weiger) => {
          mislukt = weiger;
        }),
    );
    const { result } = renderHook(() => useRobotcontrole("sleutel", laad, 5000));
    result.current?.vak(document.createElement("div"));
    const begin = Date.now();
    const wacht = result.current?.haalToken();
    mislukt(new Error("geblokkeerd"));
    expect(await wacht).toBeNull();
    expect(Date.now() - begin).toBeLessThan(1000);
  });

  it("komt uit de klem: na een geblokkeerd script lukt een volgende klik zonder de pagina te verversen", async () => {
    let geblokkeerd = true;
    const { api, widgets } = nepTurnstile();
    const laad = vi.fn(() =>
      geblokkeerd ? Promise.reject(new Error("geblokkeerd")) : Promise.resolve(api),
    );
    const { result } = renderHook(() => useRobotcontrole("sleutel", laad, 5000));
    result.current?.vak(document.createElement("div"));
    expect(await result.current?.haalToken()).toBeNull();

    // De klant zet zijn blokkeerder uit en klikt opnieuw op Doorgaan.
    geblokkeerd = false;
    const tweede = result.current?.haalToken();
    await waitFor(() => expect(widgets).toHaveLength(1));
    widgets[0]?.callback("bewijs");
    expect(await tweede).toBe("bewijs");
  });

  it("zet geen tweede widget neer als het laden gewoon lukte", async () => {
    const { api, widgets } = nepTurnstile();
    const laad = vi.fn(() => Promise.resolve(api));
    const { result } = renderHook(() => useRobotcontrole("sleutel", laad, 50));
    result.current?.vak(document.createElement("div"));
    await waitFor(() => expect(widgets).toHaveLength(1));
    // Geen bewijs binnen de wachttijd: de pagina zegt het, maar laadt niets opnieuw.
    expect(await result.current?.haalToken()).toBeNull();
    expect(laad).toHaveBeenCalledTimes(1);
    expect(widgets).toHaveLength(1);
  });

  it("geeft een verlopen bewijs niet meer af", async () => {
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
    const { result } = renderHook(() =>
      useRobotcontrole("sleutel", () => Promise.resolve(api), 50),
    );
    result.current?.vak(document.createElement("div"));
    await waitFor(() => expect(opties.callback).toBeDefined());
    opties.callback?.("oud-bewijs");
    expect(await result.current?.haalToken()).toBe("oud-bewijs");
    opties.verlopen?.();
    expect(await result.current?.haalToken()).toBeNull();
  });
});
