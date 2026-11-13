import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const signOut = vi.fn(async () => ({ error: null }));

vi.mock("@/lib/supabase", () => ({ supabase: { auth: { signOut } } }));

const { WachtOpGoedkeuring } = await import("./wacht-op-goedkeuring");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WachtOpGoedkeuring", () => {
  it("zegt dat het account wacht, op welk adres, en laat uitloggen", async () => {
    render(<WachtOpGoedkeuring adres="klant@voorbeeld.nl" />);
    expect(
      screen.getByRole("heading", { name: "Je account wacht op goedkeuring" }),
    ).toBeInTheDocument();
    expect(screen.getByText("klant@voorbeeld.nl")).toBeInTheDocument();
    // Zonder `opnieuw` geen knop die niets doet.
    expect(screen.queryByRole("button", { name: "Opnieuw kijken" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Uitloggen" }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("vraagt opnieuw na bij de knop Opnieuw kijken", async () => {
    const opnieuw = vi.fn();
    render(<WachtOpGoedkeuring adres="klant@voorbeeld.nl" opnieuw={opnieuw} />);
    await userEvent.click(screen.getByRole("button", { name: "Opnieuw kijken" }));
    expect(opnieuw).toHaveBeenCalledTimes(1);
  });
});
