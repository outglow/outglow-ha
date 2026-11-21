import { describe, expect, it } from "vitest";
import commands from "../../docs/schemas/commands.json";
import { fixtureResponses, mockConnection } from "../mock/hass";
import { SUBSCRIPTIONS } from "../src/api/types";

describe("mock backend", () => {
  it("answers every command of the contract", () => {
    const responses = fixtureResponses();
    const names = Object.keys(commands.commands).filter((c) => !(SUBSCRIPTIONS as readonly string[]).includes(c));
    expect(names.filter((name) => !responses.has(name))).toEqual([]);
  });

  it("rejects unknown commands", async () => {
    await expect(mockConnection().sendMessagePromise({ type: "outglow/nope" })).rejects.toMatchObject({
      code: "unknown_command",
    });
  });
});
