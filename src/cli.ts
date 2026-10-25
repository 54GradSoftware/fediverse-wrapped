// `node ace` operator commands: the only source of follows, and only with TESTING_MODE on
// (PRIVACY.md). Follows go into the shared outbox queue; the running bot delivers them.

import { BaseCommand, HelpCommand, Kernel, ListLoader } from "@adonisjs/ace";
import { type Actor, getActorHandle, isActor } from "@fedify/vocab";
import { cfg } from "./config.ts";
import { type Db, openDb } from "./db.ts";
import { type BotBinding, buildInstance } from "./instance.ts";

type Backend = { readonly db: Db; readonly bots: readonly BotBinding[] };

async function backend(): Promise<Backend> {
  const db = await openDb(cfg.appDbPath, cfg.actorSalt);
  const { bots } = buildInstance(db.fedify, { consumeQueues: false });
  return { db, bots };
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
    const { db, bots } = await backend();
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
      await db.close();
    }
  }
}

class Unfollow extends AccountCommand {
  static override commandName = "unfollow";
  static override description = "Unfollow an account and drop it from the test list";

  override async run(): Promise<void> {
    const { db, bots } = await backend();
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
      await db.close();
    }
  }
}

class Following extends BaseCommand {
  static override commandName = "following";
  static override description = "List the test accounts and whether each follow was accepted";

  override async run(): Promise<void> {
    const { db, bots } = await backend();
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
      await db.close();
    }
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
  kernel.addLoader(new ListLoader([Follow, Unfollow, Following]));
  return kernel;
}

/** Runs one command line and returns the exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  const kernel = createKernel();
  await kernel.handle([...argv]);
  return kernel.exitCode ?? 0;
}
