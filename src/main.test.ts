import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("de app starten met een onbekende dienst in VITE_INLOGDIENST", () => {
  it("toont een duidelijke melding in plaats van een witte pagina", async () => {
    // Bijvoorbeeld: de inrichting zet een lijst met een dienst die deze versie niet kent.
    vi.stubEnv("VITE_INLOGDIENST", "cloudflare,sso");
    const console_ = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);

    await import("./main");

    await waitFor(() => expect(root.querySelector('[role="alert"]')).not.toBeNull());
    expect(root).toHaveTextContent("Deze app kan niet starten");
    // Op het scherm (dat iedereen kan zien) alleen de naam; de waarde en de uitleg voor
    // ontwikkelaars staan in de console.
    expect(root).toHaveTextContent("kloppen niet (VITE_INLOGDIENST)");
    expect(root).not.toHaveTextContent("sso");
    expect(String(console_.mock.calls[0]?.[0])).toContain('VITE_INLOGDIENST kent "sso" niet');
  });
});
