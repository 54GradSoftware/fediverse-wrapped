import "./env.ts";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { SqliteRepository } from "@fedify/botkit-sqlite";
import { Create, Note } from "@fedify/vocab";

// TESTING_MODE is unset here: follow must refuse before opening a database or the network.
const { answerAmong, createKernel, main, repliesByTarget } = await import("../src/cli.ts");

describe("node ace", () => {
  it("offers the operator's commands", async () => {
    const kernel = createKernel();
    await kernel.boot();
    const names = kernel.getCommands().map((command) => command.commandName);
    for (const name of ["follow", "unfollow", "following", "resend"])
      assert.ok(names.includes(name), name);
  });

  it("refuses to follow outside testing mode", async () => {
    assert.equal(await main(["follow", "@someone@example.test"]), 1);
  });
});

describe("node ace resend", () => {
  const MENTION = "https://x.test/notes/1";

  /** Stores a bot post the way BotKit does after publish(), optionally as a reply. */
  async function store(repository: SqliteRepository, at: number, replyTo?: string) {
    const id = randomUUID();
    const published = Temporal.Instant.fromEpochMilliseconds(at);
    await repository.addMessage(
      "fediwrapped_de",
      id,
      new Create({
        id: new URL(`https://bot.test/create/${id}`),
        published,
        object: new Note({
          id: new URL(`https://bot.test/note/${id}`),
          published,
          replyTarget: replyTo == null ? null : new URL(replyTo),
        }),
      }),
    );
    return `https://bot.test/note/${id}`;
  }

  it('does not mistake the "you\'re queued" ack for the wrapped', async () => {
    const repository = new SqliteRepository({ path: ":memory:" });
    const ack = await store(repository, 1_000, MENTION);
    await store(repository, 1_500);
    const replies = await repliesByTarget(repository, ["fediwrapped_de"], 500);
    assert.deepEqual(replies.get(MENTION), [ack]);
    assert.equal(answerAmong({ acked: 1 }, replies.get(MENTION) ?? []), null);
    assert.equal(answerAmong({ acked: 0 }, replies.get(MENTION) ?? []), ack);

    const wrapped = await store(repository, 2_000, MENTION);
    const again = await repliesByTarget(repository, ["fediwrapped_de"], 500);
    assert.equal(answerAmong({ acked: 1 }, again.get(MENTION) ?? []), wrapped);
    repository.close();
  });
});
