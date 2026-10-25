import { BaseSchema } from "@adonisjs/lucid/schema";

// The bot's own tables, each created only if missing so pre-migration volumes are adopted.
// In defer() because this.schema queues its builders, so hasTable() would answer too late.
export default class extends BaseSchema {
  override async up(): Promise<void> {
    this.defer(async (database) => {
      // The primary key is the idempotency key: the only guard against Fedify's inbox
      // redelivery (up to 10 attempts) posting ten wrappeds into one thread.
      if (!(await database.schema.hasTable("jobs"))) {
        await database.schema.createTable("jobs", (table) => {
          table.text("message_id").notNullable().primary();
          table.text("bot").notNullable();
          // The ONE account we will analyse. Scrubbed to '' on a terminal state.
          table.text("actor_id").notNullable();
          table.text("actor_handle").notNullable();
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
          table.index(["state", "created_at"], "jobs_pick");
          table.index(["state", "host"], "jobs_host");
          table.index(["actor_hash"], "jobs_actor");
        });
      } else if (!(await database.schema.hasColumn("jobs", "not_before"))) {
        // Volumes from before not_before existed.
        await database.schema.alterTable("jobs", (table) =>
          table.integer("not_before").notNullable().defaultTo(0),
        );
      }

      // The daily ledger and user-facing rate limit, keyed by salted hash only. The key caps
      // each account at 1 wrapped + 1 refusal a day, which also ends mention loops with bots.
      if (!(await database.schema.hasTable("replies"))) {
        await database.schema.createTable("replies", (table) => {
          table.text("actor_hash").notNullable();
          table.text("day").notNullable();
          table.enu("kind", ["wrapped", "refusal"]).notNullable();
          table.integer("at").notNullable();
          table.text("outcome");
          table.text("reply_uri");
          table.primary(["actor_hash", "day", "kind"]);
          table.index(["at"], "replies_age");
        });
      }

      // Index only: PNGs live at DATA_DIR/img/<id>.png. As BLOBs they would bloat app.db
      // and DELETE would never give the space back.
      if (!(await database.schema.hasTable("images"))) {
        await database.schema.createTable("images", (table) => {
          table.text("id").notNullable().primary();
          table.text("actor_hash").notNullable();
          table.integer("created_at").notNullable();
          table.index(["created_at"], "images_age");
          table.index(["actor_hash"], "images_actor");
        });
      }

      // Testing mode only. Plain text on purpose: the operator's own test accounts,
      // which "node ace following" prints.
      if (!(await database.schema.hasTable("test_accounts"))) {
        await database.schema.createTable("test_accounts", (table) => {
          table.text("bot").notNullable();
          table.text("actor_id").notNullable();
          table.text("handle").notNullable();
          table.integer("added_at").notNullable();
          table.primary(["bot", "actor_id"]);
        });
      }
    });
  }

  override async down(): Promise<void> {
    for (const table of ["test_accounts", "images", "replies", "jobs"]) {
      this.schema.dropTableIfExists(table);
    }
  }
}
