import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { softwareOf, WITHOUT_OUTBOX } from "../src/nodeinfo.ts";

// The requests themselves are Fedify's getNodeInfo; only the mapping from its
// answer to a lowercase name is ours, so that is what gets tested.
describe("softwareOf", () => {
  it("lowercases the software name and passes the user agent through", async () => {
    const seen: string[] = [];
    const name = await softwareOf("https://example.test", "ua/1", async (origin, ua) => {
      seen.push(origin, ua);
      return { software: { name: "Pixelfed" } };
    });
    assert.equal(name, "pixelfed");
    assert.deepEqual(seen, ["https://example.test", "ua/1"]);
  });

  it("returns null when there is no usable answer", async () => {
    assert.equal(await softwareOf("https://x.test", "ua", async () => undefined), null);
    assert.equal(await softwareOf("https://x.test", "ua", async () => ({})), null);
    assert.equal(
      await softwareOf("https://x.test", "ua", async () => ({ software: { name: " " } })),
      null,
    );
    assert.equal(
      await softwareOf("https://x.test", "ua", async () => {
        throw new Error("boom");
      }),
      null,
    );
  });
});

describe("WITHOUT_OUTBOX", () => {
  it("is keyed by lowercase NodeInfo names and names each software for the reply", () => {
    for (const [key, name] of Object.entries(WITHOUT_OUTBOX)) {
      assert.equal(key, key.toLowerCase());
      assert.notEqual(name.trim(), "");
    }
    // Software that does serve a readable outbox must never be listed: a quiet
    // Mastodon account would otherwise be told its server hides its posts.
    for (const works of [
      "mastodon",
      "misskey",
      "pleroma",
      "akkoma",
      "hollo",
      "hackerspub",
      "plume",
    ]) {
      assert.equal(WITHOUT_OUTBOX[works], undefined);
    }
  });
});
