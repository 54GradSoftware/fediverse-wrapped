// `node ace` operator commands: the only source of follows, and only with TESTING_MODE on
// (PRIVACY.md). Follows go into the shared outbox queue; the running bot delivers them.
// `resend` likewise only puts jobs back in the queue; the running bot's workers answer them.

import { BaseCommand, HelpCommand, Kernel, ListLoader } from "@adonisjs/ace";
import type { SqliteRepository } from "@fedify/botkit-sqlite";
import {
  Activity,
  type Actor,
  Object as ASObject,
  getActorHandle,
  isActor,
} from "@fedify/vocab";
import { cfg } from "./config.ts";
import { type Db, dayKey, type Job, openDb } from "./db.ts";
import { type BotBinding, buildInstance } from "./instance.ts";
import { noFetch } from "./outbox.ts";

type Backend = {
  readonly db: Db;
  readonly bots: readonly BotBinding[];
  readonly repository: SqliteRepository;
  /** Closes app.db and botkit.db; call it in a finally. */
  readonly close: () => Promise<void>;
};

async function backend(): Promise<Backend> {
  const db = await openDb(cfg.appDbPath, cfg.actorSalt);
  const { bots, repository } = buildInstance(db.fedify, { consumeQueues: false });
  const close = async () => {
    repository.close();
    await db.close();
  };
  return { db, bots, repository, close };
}

function selectBots(bots: readonly BotBinding[], only: string | undefined): BotBinding[] {
  if (only == null) return [...bots];
  const found = bots.filter(
    (binding) => binding.config.locale === only || binding.config.handle === only,
  );
  if (found.length === 0) {
    throw new Error(
      `no bot "${only}"; use ${bots.map((binding) => binding.config.locale).join(" or ")}`,
    );
  }
  return found;
}

async function resolve(binding: BotBinding, account: string): Promise<Actor & { id: URL }> {
  const session = binding.bot.getSession(cfg.origin);
  const documentLoader = await session.context.getDocumentLoader({
    identifier: binding.config.handle,
  });
  const object = await session.context.lookupObject(account, { documentLoader });
  if (!isActor(object) || object.id == null) {
    throw new Error(`"${account}" does not resolve to an account`);
  }
  return object as Actor & { id: URL };
}

const handleOf = (actor: Actor, fallback: string) =>
  getActorHandle(actor, {
    trimLeadingAt: true,
    punycode: true,
    userAgent: cfg.userAgent,
  }).catch(() => fallback);

/** `<account> [--bot de|en]`, shared by follow and unfollow. */
abstract class AccountCommand extends BaseCommand {
  declare account: string;
  declare bot?: string;
  static {
    AccountCommand.defineArgument("account", {
      type: "string",
      description: "@user@host or the actor URL",
    });
    AccountCommand.defineFlag("bot", {
      type: "string",
      description: "Only this bot: de or en (default: both)",
    });
  }
}

class Follow extends AccountCommand {
  static override commandName = "follow";
  static override description = "Follow an account from the bots (testing mode only)";
  static override help = [
    "With TESTING_MODE=true the bots answer only direct messages from accounts on the test list.",
    "The account counts right away, even while the follow request is still pending.",
  ];

  override async run(): Promise<void> {
    if (!cfg.testingMode) {
      this.logger.error(
        "follow is only available with TESTING_MODE=true — in normal operation the bot must not follow anyone (PRIVACY.md)",
      );
      this.exitCode = 1;
      return;
    }
    const { db, bots, close } = await backend();
    try {
      for (const binding of selectBots(bots, this.bot)) {
        const actor = await resolve(binding, this.account);
        const handle = await handleOf(actor, this.account);
        await binding.bot.getSession(cfg.origin).follow(actor);
        await db.addTestAccount(binding.config.handle, actor.id.href, handle, Date.now());
        this.logger.success(
          `${binding.config.handle}: ${handle} added to the test list, Follow sent`,
        );
      }
    } finally {
      await close();
    }
  }
}

class Unfollow extends AccountCommand {
  static override commandName = "unfollow";
  static override description = "Unfollow an account and drop it from the test list";

  override async run(): Promise<void> {
    const { db, bots, close } = await backend();
    try {
      for (const binding of selectBots(bots, this.bot)) {
        const actor = await resolve(binding, this.account);
        await binding.bot.getSession(cfg.origin).unfollow(actor);
        await db.removeTestAccount(binding.config.handle, actor.id.href);
        this.logger.success(
          `${binding.config.handle}: unfollowed ${await handleOf(actor, this.account)}`,
        );
      }
    } finally {
      await close();
    }
  }
}

class Following extends BaseCommand {
  static override commandName = "following";
  static override description = "List the test accounts and whether each follow was accepted";

  override async run(): Promise<void> {
    const { db, bots, close } = await backend();
    try {
      const rows = await db.listTestAccounts();
      if (rows.length === 0) {
        this.logger.info("no test accounts; add one with `node ace follow @user@host`");
        return;
      }
      const table = this.ui.table().head(["bot", "account", "state", "added"]);
      for (const row of rows) {
        const binding = bots.find((candidate) => candidate.config.handle === row.bot);
        const accepted =
          binding == null
            ? false
            : await binding.bot.getSession(cfg.origin).follows(new URL(row.actor_id));
        table.row([
          row.bot,
          row.handle,
          accepted ? this.colors.green("accepted") : this.colors.yellow("pending"),
          new Date(row.added_at).toISOString().slice(0, 16).replace("T", " "),
        ]);
      }
      table.render();
    } finally {
      await close();
    }
  }
}

// Every stored reply of the bots, by the post it answers, newest first. One pass for all
// jobs: a crash while publishing may have sent the wrapped before the job was marked.
export async function repliesByTarget(
  repository: SqliteRepository,
  bots: readonly string[],
  since: number,
): Promise<Map<string, string[]>> {
  const replies = new Map<string, string[]>();
  for (const bot of bots) {
    const messages = repository.getMessages(bot, {
      since: Temporal.Instant.fromEpochMilliseconds(since),
    });
    for await (const activity of messages) {
      const object = await activity
        .getObject({ documentLoader: noFetch, suppressError: true })
        .catch(() => null);
      if (!(object instanceof ASObject) || object.id == null) continue;
      const target = object.replyTargetId?.href;
      if (target != null) replies.set(target, [...(replies.get(target) ?? []), object.id.href]);
    }
  }
  return replies;
}

/** The answer among the replies, if any: an acked job's first reply was "you're queued". */
export function answerAmong(
  job: Pick<Job, "acked">,
  replies: readonly string[],
): string | null {
  return replies.length > job.acked ? (replies[0] ?? null) : null;
}

// finishJob() scrubbed actor_id, so the author is read from the mention itself. Signed, since
// most mentions are DMs; null when the post is gone or cannot be read.
async function mentionAuthor(binding: BotBinding, messageId: string): Promise<URL | null> {
  const session = binding.bot.getSession(cfg.origin);
  const documentLoader = await session.context.getDocumentLoader({
    identifier: binding.config.handle,
  });
  const object = await session.context
    .lookupObject(messageId, { documentLoader })
    .catch(() => null);
  if (object instanceof Activity) return object.actorId;
  if (object instanceof ASObject) return object.attributionId;
  return null;
}

class Resend extends BaseCommand {
  static override commandName = "resend";
  static override description = "Queue wrapped again that crashed before any reply went out";
  static override help = [
    "Lists every job that ended as crashed without a reply. Nothing changes without --send.",
    "With --send the jobs go back into the queue as if mentioned today, and the running bot answers them.",
    "Skipped: jobs the bot already replied to, accounts with a later mention, and mentions that can no longer be read or whose author does not match the stored hash.",
  ];

  declare send: boolean;
  declare bot?: string;
  static {
    Resend.defineFlag("send", {
      type: "boolean",
      description: "Queue the jobs again (default: only list them)",
    });
    Resend.defineFlag("bot", {
      type: "string",
      description: "Only this bot: de or en (default: both)",
    });
  }

  override async run(): Promise<void> {
    const { db, bots, repository, close } = await backend();
    try {
      const selected = new Map(
        selectBots(bots, this.bot).map((binding) => [binding.config.handle, binding]),
      );
      const candidates = (await db.unansweredJobs()).filter((job) => selected.has(job.bot));
      if (candidates.length === 0) {
        this.logger.info("no crashed jobs without a reply");
        return;
      }
      const replies = await repliesByTarget(
        repository,
        [...selected.keys()],
        Math.min(...candidates.map((job) => job.created_at)),
      );

      const table = this.ui.table().head(["account", "bot", "mentioned", "action"]);
      let queued = 0;
      for (const job of candidates) {
        const action = await this.decide(db, selected.get(job.bot)!, job, replies);
        if (action === "queue") queued++;
        table.row([
          job.actor_hash.slice(0, 12),
          job.bot,
          new Date(job.created_at).toISOString().slice(0, 16).replace("T", " "),
          action === "queue"
            ? this.colors.green(this.send ? "queued again" : "would queue again")
            : action,
        ]);
      }
      table.render();
      if (this.send) {
        this.logger.success(`${queued} job(s) queued again; the running bot answers them`);
      } else if (queued > 0) {
        this.logger.info(`${queued} job(s) would be queued again; run with --send to do it`);
      }
    } finally {
      await close();
    }
  }

  /** "queue" when the job goes (or would go) back in the queue, otherwise why not. */
  private async decide(
    db: Db,
    binding: BotBinding,
    job: Job,
    replies: ReadonlyMap<string, string[]>,
  ): Promise<string> {
    const answer = answerAmong(job, replies.get(job.message_id) ?? []);
    if (answer != null) return this.colors.dim(`already answered: ${answer}`);
    if (await db.hasLaterMention(job.actor_hash, job.created_at)) {
      return this.colors.dim("a later mention covers it");
    }
    const author = await mentionAuthor(binding, job.message_id);
    if (author == null) return this.colors.yellow("mention no longer readable");
    if (db.hashActor(author.href) !== job.actor_hash) {
      return this.colors.red("mention author does not match");
    }
    if (!this.send) return "queue";
    const now = Date.now();
    const reopened = await db.reopenJob(
      job.message_id,
      author.href,
      now,
      dayKey(new Date(now), cfg.rateLimitTimeZone),
    );
    return reopened ? "queue" : this.colors.yellow("changed meanwhile, left alone");
  }
}

export function createKernel(): Kernel<typeof BaseCommand> {
  const kernel = Kernel.create();
  kernel.info.set("binary", "node ace");
  // Kernel.create() has no --help of its own; this is the wiring from its docs.
  kernel.defineFlag("help", {
    type: "boolean",
    alias: "h",
    description: "Show help for a command",
  });
  kernel.on("help", async (command, $kernel, parsed) => {
    parsed.args.unshift(command.commandName);
    await new HelpCommand($kernel, parsed, kernel.ui, kernel.prompt).exec();
    return true;
  });
  kernel.addLoader(new ListLoader([Follow, Unfollow, Following, Resend]));
  return kernel;
}

/** Runs one command line and returns the exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  const kernel = createKernel();
  await kernel.handle([...argv]);
  return kernel.exitCode ?? 0;
}
