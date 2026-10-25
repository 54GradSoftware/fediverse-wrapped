import "./env.ts";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// TESTING_MODE is unset here: follow must refuse before opening a database or the network.
const { createKernel, main } = await import("../src/cli.ts");

describe("node ace", () => {
  it("offers the operator's three commands", async () => {
    const kernel = createKernel();
    await kernel.boot();
    const names = kernel.getCommands().map((command) => command.commandName);
    for (const name of ["follow", "unfollow", "following"])
      assert.ok(names.includes(name), name);
  });

  it("refuses to follow outside testing mode", async () => {
    assert.equal(await main(["follow", "@someone@example.test"]), 1);
  });
});
