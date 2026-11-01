import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type Db, dayKey, openDb } from "../src/db.ts";
import { testDb as fresh } from "./helpers.ts";

/** Claim time for tests that are not about retry delays. */
const NOW = 10_000;

const job = (over: Partial<Parameters<Db["insertJob"]>[0]> = {}) => ({
  messageId: "https://x.test/1",
  bot: "fediwrapped_de",
  actorId: "https://x.test/users/a",
  host: "x.test",
  visibility: "public" as const,
  timeZone: "Europe/Berlin",
  tzExplicit: false,
  now: 1_000,
  ...over,
});

const count = async (db: Db, table: string) =>
  Number((await db.query.from(table).count("* as total").first())?.total);

describe("jobs", () => {
  it("accepts an activity once and ignores every redelivery", async () => {
    const db = await fresh();
    assert.equal(await db.insertJob(job()), true);
    assert.equal(await db.insertJob(job()), false);
    assert.equal(await db.insertJob(job()), false);
  });

  it("runs at most one job per remote host at a time", async () => {
    const db = await fresh();
    await db.insertJob(job({ messageId: "https://x.test/1", now: 1 }));
    await db.insertJob(job({ messageId: "https://x.test/2", now: 2 }));
    await db.insertJob(
      job({
        messageId: "https://y.test/3",
        actorId: "https://y.test/u/b",
        host: "y.test",
        now: 3,
      }),
    );

    const first = await db.claimJob(NOW);
    assert.equal(first?.host, "x.test");
    const second = await db.claimJob(NOW);
    assert.equal(second?.host, "y.test", "the second x.test job must wait");
    assert.equal(await db.claimJob(NOW), null);

    await db.finishJob(first!.message_id, "done", "ok", 10);
    assert.equal((await db.claimJob(NOW))?.host, "x.test");
  });

  it("hands one job to only one of two loops claiming at once", async () => {
    const db = await fresh();
    await db.insertJob(job());
    const [first, second] = await Promise.all([db.claimJob(NOW), db.claimJob(NOW)]);
    assert.equal([first, second].filter((claimed) => claimed != null).length, 1);
  });

  it("stops retrying after three attempts", async () => {
    const db = await fresh();
    await db.insertJob(job());
    for (let index = 0; index < 3; index++) {
      const claimed = await db.claimJob(NOW);
      assert.ok(claimed);
      await db.requeueJob(claimed.message_id, "boom", NOW);
    }
    assert.equal(await db.claimJob(NOW), null, "a fourth attempt must never happen");
  });

  it("holds a retried job until its delay has passed", async () => {
    const db = await fresh();
    await db.insertJob(job({ messageId: "https://x.test/1", now: 1 }));
    await db.insertJob(
      job({
        messageId: "https://y.test/2",
        actorId: "https://y.test/u/b",
        host: "y.test",
        now: 2,
      }),
    );
    const retried = (await db.claimJob(1_000))!;
    assert.equal(retried.host, "x.test");
    await db.requeueJob(retried.message_id, "503", 5_000);

    // The older job waits; the newer one on another host is not held up by it.
    assert.equal((await db.claimJob(4_999))?.host, "y.test");
    assert.equal(await db.claimJob(4_999), null, "claimed again before its delay");
    assert.equal((await db.claimJob(5_000))?.message_id, retried.message_id);
  });

  it("adopts a volume from before migrations, adding not_before and keeping its rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wrapped-db-"));
    try {
      const path = join(dir, "app.db");
      // A pre-migration volume: a job in our tables, no not_before, no Lucid bookkeeping.
      const old = await openDb(path, "salt");
      await old.migrate();
      await old.insertJob(job());
      await old.query.schema.alterTable("jobs", (table) => table.dropColumn("not_before"));
      await old.query.schema.dropTable("adonis_schema");
      await old.query.schema.dropTable("adonis_schema_versions");
      await old.close();

      const db = await openDb(path, "salt");
      await db.migrate();
      await db.migrate(); // and running it again changes nothing
      const claimed = await db.claimJob(NOW);
      assert.equal(claimed?.message_id, "https://x.test/1", "the old row survived");
      assert.equal(claimed?.not_before, 0);
      await db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requeues running jobs but abandons publishing ones after a crash", async () => {
    const db = await fresh();
    await db.insertJob(job({ messageId: "https://x.test/1" }));
    await db.insertJob(job({ messageId: "https://y.test/2", host: "y.test" }));
    const firstJob = (await db.claimJob(NOW))!;
    const secondJob = (await db.claimJob(NOW))!;
    await db.markPublishing(secondJob.message_id);

    const recovered = await db.recoverAfterCrash(99);
    assert.deepEqual(recovered, { requeued: 1, abandoned: 1 });
    // The abandoned one may already have been published; it must never return.
    const next = await db.claimJob(NOW);
    assert.equal(next?.message_id, firstJob.message_id);
    assert.equal(await db.claimJob(NOW), null);
  });

  it("fails a job interrupted on its last attempt instead of stranding it", async () => {
    const db = await fresh();
    await db.insertJob(job());
    for (let attempt = 1; attempt < 3; attempt++) {
      await db.claimJob(NOW);
      await db.requeueJob("https://x.test/1", "503", NOW);
    }
    await db.claimJob(NOW); // attempt 3, then the process dies

    assert.deepEqual(await db.recoverAfterCrash(99), { requeued: 0, abandoned: 1 });
    const row = await db.query.from("jobs").select("state", "finished_at", "actor_id").first();
    assert.equal(row?.state, "failed");
    assert.equal(row?.finished_at, 99, "finished, so retention can prune it");
    assert.equal(row?.actor_id, "", "and the actor is scrubbed");
    assert.equal(await db.hasOpenJob(db.hashActor("https://x.test/users/a")), false);
  });

  it("never puts a job that reached publishing back in the queue", async () => {
    const db = await fresh();
    await db.insertJob(job());
    const claimed = (await db.claimJob(NOW))!;
    await db.markPublishing(claimed.message_id);
    assert.equal(await db.requeueJob(claimed.message_id, "SQLITE_BUSY", NOW), false);
    assert.equal(await db.claimJob(NOW), null, "a second wrapped must be impossible");
  });

  it("refuses to hand the same job to two loops", async () => {
    const db = await fresh();
    await db.insertJob(job());
    const claimed = (await db.claimJob(NOW))!;
    assert.equal(await db.markPublishing(claimed.message_id), true);
    assert.equal(await db.markPublishing(claimed.message_id), false);
  });

  it("scrubs the actor once a job reaches a terminal state", async () => {
    const db = await fresh();
    await db.insertJob(job());
    const claimed = (await db.claimJob(NOW))!;
    await db.finishJob(claimed.message_id, "done", "ok", 5, "https://bot.test/note/1");
    const row = await db.query.from("jobs").select("actor_id", "actor_hash").first();
    assert.equal(row?.actor_id, "");
    assert.notEqual(row?.actor_hash, "", "the hash must survive so erasure still works");
  });

  it("claims the ack exactly once", async () => {
    const db = await fresh();
    await db.insertJob(job());
    assert.equal(await db.claimAck("https://x.test/1"), true);
    assert.equal(await db.claimAck("https://x.test/1"), false);
  });
});

describe("resending crashed jobs", () => {
  const ACTOR = "https://x.test/users/a";
  const TODAY = "2026-11-01";

  /** A job that crashed on its third attempt, the way the out-of-memory loop left them. */
  async function crashed(db: Db, over: Partial<Parameters<Db["insertJob"]>[0]> = {}) {
    await db.insertJob(job(over));
    const claimed = (await db.claimJob(NOW))!;
    await db.finishJob(claimed.message_id, "failed", "crashed", 50);
    return claimed.message_id;
  }

  it("lists only jobs that crashed without any reply", async () => {
    const db = await fresh();
    const lost = await crashed(db);
    await db.insertJob(job({ messageId: "https://y.test/2", host: "y.test" }));
    const done = (await db.claimJob(NOW))!;
    await db.finishJob(done.message_id, "done", "ok", 60, "https://bot.test/note/1");
    await db.insertJob(job({ messageId: "https://z.test/3", host: "z.test" }));
    const refused = (await db.claimJob(NOW))!;
    await db.finishJob(refused.message_id, "failed", "outboxGone", 60);

    assert.deepEqual(
      (await db.unansweredJobs()).map((row) => row.message_id),
      [lost],
    );
  });

  it("puts a crashed job back in the queue once, with fresh attempts and its actor", async () => {
    const db = await fresh();
    const lost = await crashed(db);
    assert.equal(await db.reopenJob(lost, ACTOR, 70, TODAY), true);
    assert.equal(
      await db.reopenJob(lost, ACTOR, 70, TODAY),
      false,
      "a second run changes nothing",
    );

    const claimed = await db.claimJob(NOW);
    assert.equal(claimed?.message_id, lost);
    assert.equal(claimed?.attempts, 1);
    assert.equal(claimed?.actor_id, ACTOR);
    assert.equal(claimed?.created_at, 70, "counted as mentioned today");
    assert.deepEqual(await db.unansweredJobs(), []);
  });

  it("claims today, so a new mention while it waits is refused instead of queued", async () => {
    const db = await fresh();
    const lost = await crashed(db);
    await db.reopenJob(lost, ACTOR, 70, TODAY);
    assert.equal(
      await db.acceptJob(job({ messageId: "https://x.test/2", now: 80 }), TODAY),
      "overLimit",
    );
  });

  it("reopens a job that crashed today, whose claim on the day already exists", async () => {
    const db = await fresh();
    await db.acceptJob(job(), TODAY);
    const claimed = (await db.claimJob(NOW))!;
    await db.finishJob(claimed.message_id, "failed", "crashed", 50);
    assert.equal(await db.reopenJob(claimed.message_id, ACTOR, 70, TODAY), true);
  });

  it("refuses to reopen with an actor that does not match the stored hash", async () => {
    const db = await fresh();
    const lost = await crashed(db);
    assert.equal(
      await db.reopenJob(lost, "https://x.test/users/someone-else", 70, TODAY),
      false,
    );
    assert.equal(await db.claimJob(NOW), null);
    assert.equal(await db.claimReply(db.hashActor(ACTOR), TODAY, "wrapped", 80), true);
  });

  it("never reopens a job that was answered", async () => {
    const db = await fresh();
    await db.insertJob(job());
    const claimed = (await db.claimJob(NOW))!;
    await db.finishJob(claimed.message_id, "done", "ok", 50, "https://bot.test/note/1");
    assert.equal(await db.reopenJob(claimed.message_id, ACTOR, 70, TODAY), false);
  });

  it("counts every later mention as covering an older one, except a refusal", async () => {
    const db = await fresh();
    const hash = db.hashActor(ACTOR);
    await crashed(db);
    assert.equal(await db.hasLaterMention(hash, 1_000), false);

    await db.acceptJob(job({ messageId: "https://x.test/2", now: 2_000 }), TODAY);
    await db.acceptJob(job({ messageId: "https://x.test/3", now: 3_000 }), TODAY);
    assert.equal(await db.hasLaterMention(hash, 1_000), true, "the queued one counts");
    assert.equal(await db.hasLaterMention(hash, 2_000), false, "the refused one does not");

    // Crashed as well, or answered with a failure reply: either way the newer one wins.
    await db.claimJob(NOW);
    await db.finishJob("https://x.test/2", "failed", "outboxGone", 4_000);
    assert.equal(await db.hasLaterMention(hash, 1_000), true, "a failure reply counts");
    await db.query
      .from("jobs")
      .where("message_id", "https://x.test/2")
      .update({ outcome: "crashed" });
    assert.equal(await db.hasLaterMention(hash, 1_000), true, "a newer crash counts");
  });
});

describe("accepting a mention", () => {
  const day = "2026-09-18";

  it("queues the first mention of the day and drops a redelivery", async () => {
    const db = await fresh();
    assert.equal(await db.acceptJob(job(), day), "queued");
    assert.equal(await db.acceptJob(job(), day), "duplicate");
    assert.equal((await db.claimJob(NOW))?.message_id, "https://x.test/1");
  });

  it("stores a second mention that day as rejected, so no worker ever takes it", async () => {
    const db = await fresh();
    await db.acceptJob(job({ messageId: "https://x.test/1" }), day);
    const first = await db.claimJob(NOW);
    await db.finishJob(first!.message_id, "done", "ok", NOW);

    // Claims race the acceptance; the transaction leaves nothing for them.
    const [accepted, claimed] = await Promise.all([
      db.acceptJob(job({ messageId: "https://x.test/2" }), day),
      db.claimJob(NOW),
    ]);
    assert.equal(accepted, "overLimit");
    assert.equal(claimed, null);
    assert.equal(await db.claimJob(NOW), null);
    const row = await db.query.from("jobs").where("message_id", "https://x.test/2").first();
    assert.equal(row?.state, "rejected");
    assert.equal(row?.actor_id, "", "and the actor is scrubbed");
  });
});

describe("daily ledger", () => {
  it("allows one wrapped and one refusal per account per day", async () => {
    const db = await fresh();
    const hash = db.hashActor("https://x.test/users/a");
    assert.equal(await db.claimReply(hash, "2026-09-18", "wrapped", 1), true);
    assert.equal(await db.claimReply(hash, "2026-09-18", "wrapped", 2), false);
    assert.equal(await db.claimReply(hash, "2026-09-18", "refusal", 3), true);
    assert.equal(await db.claimReply(hash, "2026-09-18", "refusal", 4), false);
    assert.equal(await db.claimReply(hash, "2026-09-19", "wrapped", 5), true);
  });

  it("gives the day back when a transient failure released it", async () => {
    const db = await fresh();
    const hash = db.hashActor("https://x.test/users/a");
    await db.claimReply(hash, "2026-09-18", "wrapped", 1);
    await db.releaseReply(hash, "2026-09-18");
    assert.equal(await db.claimReply(hash, "2026-09-18", "wrapped", 2), true);
  });

  it("stores only a salted hash, never the actor URI", async () => {
    const db = await fresh();
    const hash = db.hashActor("https://x.test/users/a");
    await db.claimReply(hash, "2026-09-18", "wrapped", 1);
    const dump = JSON.stringify(await db.query.from("replies").select("*"));
    assert.equal(dump.includes("x.test"), false);
    assert.equal(hash.length, 64);
    assert.notEqual((await fresh("other")).hashActor("https://x.test/users/a"), hash);
  });
});

describe("dayKey", () => {
  it("rolls over at local midnight, not UTC midnight", () => {
    assert.equal(dayKey(new Date("2026-01-01T23:30:00Z"), "Europe/Berlin"), "2026-01-02");
    assert.equal(dayKey(new Date("2026-01-01T22:30:00Z"), "Europe/Berlin"), "2026-01-01");
    assert.equal(dayKey(new Date("2026-01-01T23:30:00Z"), "UTC"), "2026-01-01");
  });
});

describe("retention and erasure", () => {
  it("removes everything about one account by hash alone", async () => {
    const db = await fresh();
    const hash = db.hashActor("https://x.test/users/a");
    await db.insertJob(job());
    await db.claimReply(hash, "2026-09-18", "wrapped", 1);
    await db.recordImage("11111111-1111-1111-1111-111111111111", hash, 1);
    const ids = await db.eraseActor(hash);
    assert.deepEqual(ids, ["11111111-1111-1111-1111-111111111111"]);
    assert.equal(await count(db, "jobs"), 0);
    assert.equal(await count(db, "replies"), 0);
    assert.equal(await count(db, "images"), 0);
  });

  it("prunes only rows past their retention", async () => {
    const db = await fresh();
    await db.insertJob(job({ messageId: "old" }));
    await db.finishJob("old", "done", "ok", 100);
    await db.insertJob(job({ messageId: "new", host: "y.test" }));
    await db.finishJob("new", "done", "ok", 10_000);
    assert.equal(await db.pruneJobs(5_000), 1);
    assert.equal(await count(db, "jobs"), 1);
  });
});

describe("test accounts", () => {
  it("round-trips per bot and upserts the handle", async () => {
    const db = await fresh();
    await db.addTestAccount("fediwrapped_de", "https://x.test/users/a", "a@x.test", 1);
    await db.addTestAccount("fediwrapped_en", "https://x.test/users/a", "a@x.test", 2);
    await db.addTestAccount("fediwrapped_de", "https://x.test/users/a", "a@example.social", 3);
    assert.deepEqual(
      (await db.listTestAccounts()).map((row) => [row.bot, row.handle]),
      [
        ["fediwrapped_de", "a@example.social"],
        ["fediwrapped_en", "a@x.test"],
      ],
    );
    assert.equal(await db.isTestAccount("fediwrapped_de", "https://x.test/users/a"), true);
    assert.equal(await db.isTestAccount("fediwrapped_de", "https://x.test/users/b"), false);
    assert.equal(await db.removeTestAccount("fediwrapped_de", "https://x.test/users/a"), true);
    assert.equal(
      await db.isTestAccount("fediwrapped_de", "https://x.test/users/a"),
      false,
      "per bot",
    );
    assert.equal(
      await db.isTestAccount("fediwrapped_en", "https://x.test/users/a"),
      true,
      "per bot",
    );
    assert.equal(await db.removeTestAccount("fediwrapped_de", "https://x.test/users/a"), false);
    assert.equal((await db.listTestAccounts()).length, 1);
  });
});
