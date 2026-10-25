import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { text } from "@fedify/botkit";
import { testDb } from "./helpers.ts";

// TESTING_MODE is set before config.ts is imported; env.ts fills in the rest.
process.env.TESTING_MODE = "true";
await import("./env.ts");
const { cfg } = await import("../src/config.ts");
const { dayKey } = await import("../src/db.ts");
const { makeMentionHandler } = await import("../src/handlers.ts");
const { catalogueFor } = await import("../src/strings.ts");

type Handler = ReturnType<typeof makeMentionHandler>;
type Session = Parameters<Handler>[0];
type Message = Parameters<Handler>[1];
type Block = ReturnType<typeof text>;

const renderSession = {
  actorId: new URL("https://bot.test/ap/actor/x"),
  context: { origin: "https://bot.test" },
} as unknown as Parameters<Block["getHtml"]>[0];

async function html(block: unknown): Promise<string> {
  let out = "";
  for await (const chunk of (block as Block).getHtml(renderSession)) out += chunk;
  return out;
}

function first<Item>(items: readonly Item[]): Item {
  const item = items[0];
  if (item == null) throw new Error("no bot configured");
  return item;
}
const BOT = first(cfg.bots);
const botActor = new URL(`/ap/actor/${BOT.identifier}`, cfg.origin);

/** A mention from a stranger's server, with the calls the handler makes recorded. */
function mention(
  follows: boolean,
  id = "https://remote.test/notes/1",
  actor = "https://remote.test/users/alice",
  // Testing mode answers direct messages only.
  visibility = "direct",
) {
  const calls: string[] = [];
  const replies: unknown[] = [];
  const session = {
    actorId: botActor,
    bot: { identifier: BOT.identifier },
    context: { getActorUri: (id: string) => new URL(`/ap/actor/${id}`, cfg.origin) },
    follows: async () => {
      calls.push("follows");
      return follows;
    },
  } as unknown as Session;
  const message = {
    id: new URL(id),
    actor: { id: new URL(actor), preferredUsername: "alice" },
    mentions: [{ id: botActor }],
    visibility,
    text: "@fediwrapped_de hi",
    like: async () => {
      calls.push("like");
      return undefined;
    },
    reply: async (body: unknown) => {
      calls.push("reply");
      replies.push(body);
      return undefined;
    },
  } as unknown as Message;
  return { session, message, calls, replies };
}

describe("testing mode", () => {
  it("is on for this test file", () => {
    assert.equal(cfg.testingMode, true);
  });

  it("drops a mention from an account the bot does not follow, without any reaction", async () => {
    const db = await testDb();
    const { session, message, calls } = mention(false);
    await makeMentionHandler(db)(session, message);
    assert.deepEqual(calls, ["follows"], "no like, no reply, nothing else");
    assert.equal(await db.jobsAhead(Date.now()), 0, "no job was queued");
  });

  it("drops a public mention even from an account the bot follows", async () => {
    // Nothing the bot posts during the beta may be public.
    const db = await testDb();
    for (const visibility of ["public", "unlisted", "followers"]) {
      const { session, message, calls } = mention(
        true,
        `https://remote.test/notes/${visibility}`,
        "https://remote.test/users/alice",
        visibility,
      );
      await makeMentionHandler(db)(session, message);
      assert.deepEqual(calls, [], `${visibility}: no lookup, no like, no reply`);
    }
    assert.equal(await db.jobsAhead(Date.now()), 0, "no job was queued");
  });

  it("calls itself a closed beta", () => {
    for (const bot of cfg.bots) {
      assert.match(catalogueFor(bot.locale).botNameBeta, /Beta/);
    }
  });

  it("serves a direct message from an account the bot follows as in normal operation", async () => {
    const db = await testDb();
    const { session, message, calls } = mention(true);
    await makeMentionHandler(db)(session, message);
    assert.ok(calls.includes("like"), "the mention was favourited");
    assert.equal(await db.jobsAhead(Date.now()), 1, "one job was queued");
  });
});

describe("a second mention on the same day", () => {
  it("says the wrapped is on its way while the first one is still queued", async () => {
    const db = await testDb();
    const handler = makeMentionHandler(db);
    const first = mention(true);
    await handler(first.session, first.message);

    const again = mention(true, "https://remote.test/notes/2");
    await handler(again.session, again.message);
    assert.equal(again.replies.length, 1);
    const reply = await html(again.replies[0]);
    assert.match(reply, /schon in Arbeit/);
    assert.doesNotMatch(reply, /nicht geklappt/, "must not claim the running wrapped failed");
  });

  it("says it did not work out once the first one has failed", async () => {
    const db = await testDb();
    const handler = makeMentionHandler(db);
    const first = mention(true);
    await handler(first.session, first.message);
    const hash = db.hashActor("https://remote.test/users/alice");
    await db.finishJob("https://remote.test/notes/1", "failed", "outboxGone", Date.now());
    await db.setReplyOutcome(hash, dayKey(new Date(), cfg.rateLimitTimeZone), "outboxGone");

    const again = mention(true, "https://remote.test/notes/2");
    await handler(again.session, again.message);
    assert.match(await html(again.replies[0]), /nicht geklappt/);
  });
});

describe("host trigger budget", () => {
  it("is not spent by redeliveries of a mention it already has", async () => {
    const db = await testDb();
    const handler = makeMentionHandler(db);
    // Fedify retries a delivery up to ten times; several retried mentions must
    // not lock out the next genuine one from the same server.
    for (let index = 0; index < 40; index++) {
      const again = mention(true, "https://budget.test/notes/1", "https://budget.test/users/a");
      await handler(again.session, again.message);
    }
    const other = mention(true, "https://budget.test/notes/2", "https://budget.test/users/b");
    await handler(other.session, other.message);
    assert.ok(
      await db.hasJob("https://budget.test/notes/2"),
      "the second account's mention was queued",
    );
  });
});
