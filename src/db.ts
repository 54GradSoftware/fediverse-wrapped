// The only file that queries the database (Lucid builder, no SQL), so storage is audited here.
// app.db: our tables plus Fedify's KV and queues. botkit.db: BotKit's own, see src/instance.ts.

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Application } from "@adonisjs/core/app";
import { Emitter } from "@adonisjs/core/events";
import { Logger } from "@adonisjs/core/logger";
import { Database } from "@adonisjs/lucid/database";
import { MigrationRunner } from "@adonisjs/lucid/migration";
import type { QueryClientContract } from "@adonisjs/lucid/types/database";
import type { InsertQueryBuilderContract } from "@adonisjs/lucid/types/querybuilder";

export type JobState = "queued" | "running" | "publishing" | "done" | "failed" | "rejected";
export type ReplyKind = "wrapped" | "refusal";
export type Visibility = "public" | "unlisted" | "direct";

const OPEN_STATES: JobState[] = ["queued", "running", "publishing"];
const BUSY_STATES: JobState[] = ["running", "publishing"];

/** How long the node:sqlite handle waits on a lock; better-sqlite3's default. */
const BUSY_TIMEOUT_MS = 5_000;

export type Job = {
  message_id: string;
  bot: string;
  actor_id: string;
  actor_hash: string;
  host: string;
  visibility: Visibility;
  time_zone: string;
  tz_explicit: number;
  state: JobState;
  attempts: number;
  not_before: number;
  acked: number;
  created_at: number;
};

export type TestAccount = {
  readonly bot: string;
  readonly actor_id: string;
  readonly handle: string;
  readonly added_at: number;
};

// Whether an onConflict().ignore() insert added a row. Lucid's SQLite dialect drops
// returning(), so it is set on the underlying Knex query instead.
async function insertedRow(
  query: InsertQueryBuilderContract,
  column: string,
): Promise<boolean> {
  query.knexQuery.returning(column);
  return ((await query) as unknown[]).length > 0;
}

export type NewJob = {
  messageId: string;
  bot: string;
  actorId: string;
  host: string;
  visibility: Visibility;
  timeZone: string;
  tzExplicit: boolean;
  now: number;
};

export type Db = Awaited<ReturnType<typeof openDb>>;

export async function openDb(path: string, salt: string) {
  if (path !== ":memory:") {
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (dir) mkdirSync(dir, { recursive: true });
  }

  // Standalone Lucid needs an Application, logger and emitter, wired as its test helpers do.
  const app = new Application(new URL("../", import.meta.url), { environment: "unknown" });
  await app.init();
  const lucid = new Database(
    {
      connection: "app",
      connections: {
        app: {
          client: "better-sqlite3",
          connection: { filename: path },
          useNullAsDefault: true,
        },
      },
    },
    new Logger({ enabled: false }),
    new Emitter(app),
  );
  const client = lucid.connection();

  // Fedify's KV and queues want a node:sqlite handle; they add their tables and enable WAL.
  // In-memory databases cannot be shared between connections, so tests get a separate one.
  const fedify = new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS });

  /** Salted so the ledger is not a readable list of the bot's users. */
  const hashActor = (actorId: string): string =>
    createHash("sha256").update(salt).update(":").update(actorId).digest("hex");

  // Both take the client to run on, so acceptJob() can use them inside its transaction.
  const insertJobOn = (runner: QueryClientContract, job: NewJob): Promise<boolean> =>
    insertedRow(
      runner
        .insertQuery()
        .table("jobs")
        .insert({
          message_id: job.messageId,
          bot: job.bot,
          actor_id: job.actorId,
          actor_hash: hashActor(job.actorId),
          host: job.host,
          visibility: job.visibility,
          time_zone: job.timeZone,
          tz_explicit: job.tzExplicit ? 1 : 0,
          created_at: job.now,
        })
        .onConflict("message_id")
        .ignore(),
      "message_id",
    );
  const claimReplyOn = (
    runner: QueryClientContract,
    actorHash: string,
    day: string,
    kind: ReplyKind,
    now: number,
  ): Promise<boolean> =>
    insertedRow(
      runner
        .insertQuery()
        .table("replies")
        .insert({ actor_hash: actorHash, day, kind, at: now })
        .onConflict(["actor_hash", "day", "kind"])
        .ignore(),
      "actor_hash",
    );

  const jobs = () => client.from("jobs");
  const replies = () => client.from("replies");
  const images = () => client.from("images");

  return {
    fedify,
    /** The Lucid client, for tests that inspect rows. src/ uses the functions below. */
    query: client,
    hashActor,

    // Only the bot migrates, at boot: SQLite has no advisory lock, so two processes
    // could record a migration twice. The CLI expects a database the bot has opened.
    async migrate(): Promise<void> {
      const runner = new MigrationRunner(lucid, app, {
        direction: "up",
        connectionName: "app",
      });
      await runner.run();
      // run() never throws; a failed migration only shows up here.
      if (runner.status === "error") throw runner.error;
    },

    async close(): Promise<void> {
      await lucid.manager.closeAll();
      fedify.close();
    },

    /** Proves the database answers; used by /healthz. */
    async ping(): Promise<void> {
      await images().select("id").limit(1);
    },

    // --- jobs -------------------------------------------------------------

    // Stores the job and claims the day in one transaction, so workers never see an undecided
    // job. Every statement writes, so the lock is taken at once (no busy snapshot).
    async acceptJob(job: NewJob, day: string): Promise<"duplicate" | "queued" | "overLimit"> {
      return await client.transaction(async (transaction) => {
        if (!(await insertJobOn(transaction, job))) return "duplicate";
        const actorHash = hashActor(job.actorId);
        if (await claimReplyOn(transaction, actorHash, day, "wrapped", job.now))
          return "queued";
        await transaction.from("jobs").where("message_id", job.messageId).update({
          state: "rejected",
          outcome: "dailyLimit",
          finished_at: job.now,
          actor_id: "",
        });
        return "overLimit";
      });
    },

    /** false means this exact activity was already stored. Tests use it to set up jobs. */
    async insertJob(job: NewJob): Promise<boolean> {
      return await insertJobOn(client, job);
    },

    async jobsAhead(createdAt: number): Promise<number> {
      const row = await jobs()
        .whereIn("state", OPEN_STATES)
        .where("created_at", "<", createdAt)
        .count("* as total")
        .first();
      return Number(row?.total ?? 0);
    },

    /** Compare-and-swap claim on the "you're queued" ack, so a redelivery never double-acks. */
    async claimAck(messageId: string): Promise<boolean> {
      const changed = await jobs()
        .where({ message_id: messageId, acked: 0 })
        .update({ acked: 1 });
      return Number(changed) > 0;
    },

    // One running job per host, rechecked inside the atomic UPDATE so only one loop wins. Not a
    // read-then-write transaction: in WAL that fails (busy snapshot) if Fedify writes between.
    async claimJob(now: number): Promise<Job | null> {
      const hostIdle = (outer: string) => (busy: ReturnType<typeof jobs>) =>
        busy
          .from("jobs as busy")
          .select("busy.message_id")
          .whereIn("busy.state", BUSY_STATES)
          .whereColumn("busy.host", `${outer}.host`);

      const candidate = (await client
        .from("jobs as waiting")
        .select("waiting.message_id", "waiting.attempts")
        .where("waiting.state", "queued")
        .where("waiting.attempts", "<", 3)
        .where("waiting.not_before", "<=", now)
        .whereNotExists(hostIdle("waiting"))
        .orderBy("waiting.created_at")
        .first()) as Pick<Job, "message_id" | "attempts"> | null;
      if (candidate == null) return null;

      const [claimed] = (await jobs()
        .where({
          message_id: candidate.message_id,
          state: "queued",
          attempts: candidate.attempts,
        })
        .whereNotExists(hostIdle("jobs"))
        // update()'s second argument reaches Knex as-is, so RETURNING works here.
        .update({ state: "running", attempts: candidate.attempts + 1 }, "*")) as Job[];
      return claimed ?? null;
    },

    /** Read-only twin of acceptJob()'s conflict check; acceptJob() stays authoritative. */
    async hasJob(messageId: string): Promise<boolean> {
      return (await jobs().select("message_id").where("message_id", messageId).first()) != null;
    },

    async hasOpenJob(actorHash: string): Promise<boolean> {
      const row = await jobs()
        .select("message_id")
        .where("actor_hash", actorHash)
        .whereIn("state", OPEN_STATES)
        .first();
      return row != null;
    },

    /** false means another loop already owns this job; the caller must abort. */
    async markPublishing(messageId: string): Promise<boolean> {
      const changed = await jobs()
        .where({ message_id: messageId, state: "running" })
        .update({ state: "publishing" });
      return Number(changed) > 0;
    },

    /** Terminal state. Scrubs actor_id so it is not kept through the 30-day retention. */
    async finishJob(
      messageId: string,
      state: "done" | "failed" | "rejected",
      outcome: string,
      now: number,
      replyUri?: string,
      error?: string,
    ): Promise<void> {
      await jobs()
        .where("message_id", messageId)
        .update({
          state,
          outcome,
          finished_at: now,
          reply_uri: replyUri ?? null,
          last_error: error ?? null,
          actor_id: "",
        });
    },

    async requeueJob(messageId: string, error: string, notBefore: number): Promise<boolean> {
      // Only from 'running': a 'publishing' job may already be in the thread, and
      // requeueing it would post the wrapped twice.
      const changed = await jobs()
        .where({ message_id: messageId, state: "running" })
        .update({ state: "queued", last_error: error, not_before: notBefore });
      return Number(changed) > 0;
    },

    // At boot: requeue 'running' jobs unless on their third (last) attempt. Fail 'publishing'
    // ones: the reply may be out, and a duplicate wrapped is worse than none.
    async recoverAfterCrash(now: number): Promise<{ requeued: number; abandoned: number }> {
      const requeued = await jobs()
        .where("state", "running")
        .where("attempts", "<", 3)
        .update({ state: "queued" });
      const abandoned = await jobs()
        .where("state", "publishing")
        .orWhere((last) => last.where("state", "running").where("attempts", ">=", 3))
        .update({
          state: "failed",
          outcome: "crashed",
          finished_at: now,
          actor_id: "",
        });
      return { requeued: Number(requeued), abandoned: Number(abandoned) };
    },

    // --- daily ledger -----------------------------------------------------

    /** false means this account already used its one wrapped (or refusal) today. */
    async claimReply(
      actorHash: string,
      day: string,
      kind: ReplyKind,
      now: number,
    ): Promise<boolean> {
      return await claimReplyOn(client, actorHash, day, kind, now);
    },

    /** Gives the day back after a transient failure, so a passing 429 does not burn it. */
    async releaseReply(actorHash: string, day: string): Promise<void> {
      await replies().where({ actor_hash: actorHash, day, kind: "wrapped" }).delete();
    },

    async setReplyOutcome(
      actorHash: string,
      day: string,
      outcome: string,
      replyUri?: string,
    ): Promise<void> {
      await replies()
        .where({ actor_hash: actorHash, day, kind: "wrapped" })
        .update({ outcome, reply_uri: replyUri ?? null });
    },

    /** What this account already got today, so the refusal can link to it. */
    async todaysWrapped(
      actorHash: string,
      day: string,
    ): Promise<{ outcome: string | null; reply_uri: string | null } | null> {
      return await replies()
        .select("outcome", "reply_uri")
        .where({ actor_hash: actorHash, day, kind: "wrapped" })
        .first();
    },

    // --- images -----------------------------------------------------------

    async recordImage(id: string, actorHash: string, now: number): Promise<void> {
      await client
        .insertQuery()
        .table("images")
        .insert({ id, actor_hash: actorHash, created_at: now });
    },

    async imageExists(id: string): Promise<boolean> {
      return (await images().select("id").where("id", id).first()) != null;
    },

    // --- retention and erasure -------------------------------------------

    /** Image ids past retention; the caller unlinks the files. */
    async expiredImages(before: number): Promise<string[]> {
      const rows = await images().select("id").where("created_at", "<", before);
      return rows.map((row) => String(row.id));
    },

    async deleteImages(ids: readonly string[]): Promise<void> {
      if (ids.length > 0)
        await images()
          .whereIn("id", [...ids])
          .delete();
    },

    async pruneJobs(before: number): Promise<number> {
      const deleted = await jobs()
        .whereNotNull("finished_at")
        .where("finished_at", "<", before)
        .whereIn("state", ["done", "failed", "rejected"])
        .delete();
      return Number(deleted);
    },

    async pruneLedger(before: number): Promise<number> {
      return Number(await replies().where("at", "<", before).delete());
    },

    /** GDPR Art. 17: erases all rows for one salted hash; the caller unlinks the files. */
    async eraseActor(actorHash: string): Promise<string[]> {
      const rows = await images().select("id").where("actor_hash", actorHash);
      await images().where("actor_hash", actorHash).delete();
      await replies().where("actor_hash", actorHash).delete();
      await jobs().where("actor_hash", actorHash).delete();
      return rows.map((row) => String(row.id));
    },

    // --- testing mode -----------------------------------------------------

    async addTestAccount(
      bot: string,
      actorId: string,
      handle: string,
      at: number,
    ): Promise<void> {
      await client
        .insertQuery()
        .table("test_accounts")
        .insert({ bot, actor_id: actorId, handle, added_at: at })
        .onConflict(["bot", "actor_id"])
        .merge(["handle"]);
    },

    async removeTestAccount(bot: string, actorId: string): Promise<boolean> {
      const deleted = await client
        .from("test_accounts")
        .where({ bot, actor_id: actorId })
        .delete();
      return Number(deleted) > 0;
    },

    async listTestAccounts(): Promise<TestAccount[]> {
      return (await client
        .from("test_accounts")
        .select("bot", "actor_id", "handle", "added_at")
        .orderBy([{ column: "added_at" }, { column: "bot" }])) as TestAccount[];
    },
  };
}

/** Calendar day in the configured zone, as YYYY-MM-DD. */
export function dayKey(at: Date, timeZone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(at.getTime())
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
    .toString();
}
