import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Actor,
  anoniem,
  controleerAfscherming,
  maakActor,
  verwijderActor,
} from "./lib/afscherming";

/**
 * De belangrijkste test van deze stack.
 *
 * In een browser-app is er geen server die controleert of iemand mag wat hij
 * opvraagt. Als de RLS-policies fout staan, kan een ingelogde gebruiker met een
 * beetje kennis álle gegevens van álle klanten ophalen, terwijl de app er van
 * buiten volstrekt normaal uitziet. Er is geen enkele andere test die dat vangt.
 *
 * Het patroon: log in als A, probeer bij de gegevens van B te komen, verwacht leeg.
 * Elke tabel krijgt minstens de A/B-test met `controleerAfscherming` (hieronder het
 * voorbeeld voor items); `guard:rls-tests` kijkt of die er voor elke tabel is. De andere
 * tests hier laten zien wat je er per tabel nog bij kunt zetten.
 */
let alice: Actor;
let bob: Actor;

beforeAll(async () => {
  alice = await maakActor("alice");
  bob = await maakActor("bob");

  const { error } = await alice.client
    .from("items")
    .insert({ title: "Geheim van Alice", owner_id: alice.id });
  if (error) throw new Error(`Alice kon haar eigen item niet aanmaken: ${error.message}`);
});

afterAll(async () => {
  await verwijderActor(alice);
  await verwijderActor(bob);
});

describe("items: row level security", () => {
  it("de A/B-test: gebruiker B ziet, wijzigt en verwijdert de rij van A niet", async () => {
    await controleerAfscherming({
      tabel: "items",
      maakRijAlsA: async (a) => {
        const { data, error } = await a.client
          .from("items")
          .insert({ title: "Van A", owner_id: a.id })
          .select("id")
          .single();
        if (error) throw new Error(`A kon geen item maken: ${error.message}`);
        return data.id;
      },
    });
  });

  it("laat de eigenaar het eigen item zien", async () => {
    const { data, error } = await alice.client.from("items").select("id, title");
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0]?.title).toBe("Geheim van Alice");
  });

  it("laat een andere gebruiker niets zien", async () => {
    const { data, error } = await bob.client.from("items").select("id, title");
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("staat niet toe dat je een item op naam van een ander zet", async () => {
    const { error } = await bob.client
      .from("items")
      .insert({ title: "Namens Alice", owner_id: alice.id });
    expect(error).not.toBeNull();
  });

  it("staat niet toe dat een ander jouw item wijzigt", async () => {
    const { data: mine } = await alice.client.from("items").select("id").limit(1);
    const id = mine?.[0]?.id;
    expect(id).toBeDefined();
    if (!id) return;

    const { data: updated } = await bob.client
      .from("items")
      .update({ title: "Gekaapt" })
      .eq("id", id)
      .select();
    expect(updated).toEqual([]);
  });

  it("staat niet toe dat een ander jouw item verwijdert", async () => {
    const { data: mine } = await alice.client.from("items").select("id").limit(1);
    const id = mine?.[0]?.id;
    expect(id).toBeDefined();
    if (!id) return;

    await bob.client.from("items").delete().eq("id", id);
    const { data: stillThere } = await alice.client.from("items").select("id").eq("id", id);
    expect(stillThere).toHaveLength(1);
  });

  it("laat een uitgelogde bezoeker helemaal niets zien", async () => {
    const { data } = await anoniem().from("items").select("id");
    expect(data ?? []).toEqual([]);
  });
});
