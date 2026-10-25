import { BaseSchema } from "@adonisjs/lucid/schema";

/** Every column jobs keeps, in table order; the copy below relies on that order. */
const KEPT = [
  "message_id",
  "bot",
  "actor_id",
  "actor_hash",
  "host",
  "visibility",
  "time_zone",
  "tz_explicit",
  "state",
  "attempts",
  "not_before",
  "acked",
  "created_at",
  "finished_at",
  "reply_uri",
  "outcome",
  "last_error",
];

// Drops jobs.actor_handle (plain-text user@host, never read). Rebuilt, not dropColumn(): Knex
// cannot parse the hand-written CREATE (comments, STRICT) that pre-migration volumes carry.
export default class extends BaseSchema {
  override async up(): Promise<void> {
    this.defer(async (database) => {
      await database.schema.createTable("jobs_rebuilt", (table) => {
        table.text("message_id").notNullable().primary();
        table.text("bot").notNullable();
        // The ONE account we will analyse. Scrubbed to '' on a terminal state.
        table.text("actor_id").notNullable();
        // Survives the scrub, so an erasure request can still find the images.
        table.text("actor_hash").notNullable();
        // Host of actor_id: the fairness gate that keeps two jobs off one instance.
        table.text("host").notNullable();
        table.enu("visibility", ["public", "unlisted", "direct"]).notNullable();
        table.text("time_zone").notNullable();
        table.integer("tz_explicit").notNullable().defaultTo(0);
        table
          .enu("state", ["queued", "running", "publishing", "done", "failed", "rejected"])
          .notNullable()
          .defaultTo("queued");
        table.integer("attempts").notNullable().defaultTo(0);
        // A retried job is not claimed again before this time (epoch ms).
        table.integer("not_before").notNullable().defaultTo(0);
        table.integer("acked").notNullable().defaultTo(0);
        table.integer("created_at").notNullable();
        table.integer("finished_at");
        table.text("reply_uri");
        table.text("outcome");
        table.text("last_error");
      });
      await database
        .knexQuery()
        .table("jobs_rebuilt")
        .insert(database.knexQuery().from("jobs").select(KEPT));
      // Dropping the old table drops its indexes, so their names are free again.
      await database.schema.dropTable("jobs");
      await database.schema.renameTable("jobs_rebuilt", "jobs");
      await database.schema.alterTable("jobs", (table) => {
        table.index(["state", "created_at"], "jobs_pick");
        table.index(["state", "host"], "jobs_host");
        table.index(["actor_hash"], "jobs_actor");
      });
    });
  }

  override async down(): Promise<void> {
    this.schema.alterTable("jobs", (table) => {
      table.text("actor_handle").notNullable().defaultTo("");
    });
  }
}
