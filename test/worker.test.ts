import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { testDb } from "./helpers.ts";

await import("./env.ts");
const { cfg } = await import("../src/config.ts");
const { HostLimiter } = await import("../src/limiter.ts");
const { jobFailure, resolveActor, startWorkers } = await import("../src/worker.ts");
const { OutboxError } = await import("../src/outbox.ts");
const { Person } = await import("@fedify/vocab");

const BOT = cfg.bots[0]!.identifier;
const ACTOR = "https://remote.test/users/alice";

type Loaders = Parameters<typeof resolveActor>[2];
type Session = Parameters<typeof resolveActor>[0];

/** A loader that answers every request with this HTTP status. */
const failing = (status: number) => async () => {
  const error = new Error(`${status}`) as Error & { response: Response };
  error.response = new Response("", { status });
  throw error;
};

/** Mirrors Fedify: lookupObject calls the loader and turns any failure into null. */
const sessionReturning = (actor: unknown) =>
  ({
    context: {
      lookupObject: async (
        id: string,
        { documentLoader }: { documentLoader: (url: string) => Promise<unknown> },
      ) => {
        try {
          await documentLoader(id);
        } catch {
          return null;
        }
        return actor;
      },
    },
  }) as unknown as Session;

const loaders = (signed: number, unsigned: number) =>
  ({ signed: failing(signed), unsigned: failing(unsigned) }) as unknown as Loaders;

describe("job setup", () => {
  it("retries a job whose session could not be opened instead of dropping it", async () => {
    const db = await testDb();
    await db.insertJob({
      messageId: "https://remote.test/notes/1",
      bot: BOT,
      actorId: ACTOR,
      host: "remote.test",
      visibility: "public",
      timeZone: "UTC",
      tzExplicit: false,
      now: Date.now() - 1000,
    });

    // Aborting inside the call lets the worker finish this one job and stop.
    const stop = new AbortController();
    const getSession = async () => {
      stop.abort();
      throw new Error("SQLITE_BUSY: database is locked");
    };
    await startWorkers(
      { db, bots: [], getSession, limiter: new HostLimiter() },
      1,
      stop.signal,
    );

    assert.ok(await db.hasOpenJob(db.hashActor(ACTOR)), "requeued, not marked crashed");
    assert.equal(await db.claimJob(Date.now()), null, "and only after the retry delay");
    assert.ok(await db.claimJob(Date.now() + 61_000), "then it is picked up again");
  });
});

describe("our own failures", () => {
  it("are never blamed on the user's server", () => {
    const failure = jobFailure(new TypeError("cannot read properties of undefined"));
    assert.equal(failure.kind, "internalError");
    assert.equal(failure.transient, true, "a busy database deserves its retries");
    const remote = new OutboxError("outboxGone", false, "410");
    assert.equal(jobFailure(remote), remote, "remote failures keep their own kind");
  });

  it("are answered with the internal error reply once the retries are spent", async () => {
    const db = await testDb();
    await db.insertJob({
      messageId: "https://remote.test/notes/2",
      bot: BOT,
      actorId: ACTOR,
      host: "remote.test",
      visibility: "direct",
      timeZone: "UTC",
      tzExplicit: false,
      now: Date.now() - 1000,
    });
    // Two attempts already failed; this is the last one.
    for (let attempt = 1; attempt < 3; attempt++) {
      await db.claimJob(Date.now());
      await db.requeueJob("https://remote.test/notes/2", "SQLITE_BUSY", 0);
    }

    const stop = new AbortController();
    const person = new Person({ id: new URL(ACTOR), preferredUsername: "alice" });
    const sent: { body?: { getHtml: (session: unknown) => AsyncIterable<string> } } = {};
    const replySession = {
      actorId: new URL(`${cfg.origin}/ap/actor/${BOT}`),
      context: {
        origin: cfg.origin,
        getDocumentLoader: async () => async () => ({}),
        lookupObject: async () => person,
      },
      publish: async (body: typeof sent.body) => {
        sent.body = body;
        stop.abort();
      },
    };
    let calls = 0;
    const getSession = async () => {
      // The job itself fails on our side; the failure reply gets a session.
      if (calls++ === 0) throw new Error("SQLITE_BUSY: database is locked");
      return replySession as unknown as Session;
    };
    await startWorkers(
      { db, bots: [], getSession, limiter: new HostLimiter() },
      1,
      stop.signal,
    );

    assert.ok(sent.body != null, "the user got an answer");
    let html = "";
    for await (const chunk of sent.body.getHtml(replySession)) html += chunk;
    assert.match(html, /schiefgelaufen|something broke/);
    assert.match(html, /href="https:\/\/hachyderm\.io\/@sabrinkmann"/);
    assert.equal(await db.hasOpenJob(db.hashActor(ACTOR)), false, "and the job is finished");
  });
});

describe("actor lookup", () => {
  it("retries a server having a bad minute instead of calling the account gone", async () => {
    const error = await resolveActor(sessionReturning(null), ACTOR, loaders(503, 503)).catch(
      (error: unknown) => error,
    );
    assert.ok(error instanceof OutboxError);
    assert.equal(error.transient, true, "a 503 must be retried");
    assert.equal(error.kind, "hostUnavailable");
  });

  it("prefers the transient answer when the two attempts disagree", async () => {
    // Signed hits a 429, unsigned is refused by authorized fetch.
    const error = await resolveActor(sessionReturning(null), ACTOR, loaders(429, 401)).catch(
      (error: unknown) => error,
    );
    assert.ok(error instanceof OutboxError);
    assert.equal(error.kind, "rateLimited");
  });

  it("still reports a deleted account as gone", async () => {
    const error = await resolveActor(sessionReturning(null), ACTOR, loaders(410, 404)).catch(
      (error: unknown) => error,
    );
    assert.ok(error instanceof OutboxError);
    assert.equal(error.kind, "outboxGone");
    assert.equal(error.transient, false);
  });

  it("keeps no account URI in the failure message", async () => {
    const error = await resolveActor(sessionReturning(null), ACTOR, loaders(404, 404)).catch(
      (error: unknown) => error,
    );
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes("alice"), false);
  });

  it("returns the actor when the lookup succeeds", async () => {
    const person = new Person({ id: new URL(ACTOR) });
    const ok = { signed: async () => ({}), unsigned: async () => ({}) } as unknown as Loaders;
    assert.equal(await resolveActor(sessionReturning(person), ACTOR, ok), person);
  });
});
