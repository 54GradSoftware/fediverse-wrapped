// Wiring only: one BotKit instance, two bot actors sharing kv, repository and queues.

import type { DatabaseSync } from "node:sqlite";
import type { Bot, Text } from "@fedify/botkit";
import {
  createInstance,
  link,
  ParallelMessageQueue,
  plainText,
  Service,
  text,
} from "@fedify/botkit";
import { SqliteRepository } from "@fedify/botkit-sqlite";
import type { FederationQueueOptions, MessageQueue } from "@fedify/fedify";
import { SqliteKvStore, SqliteMessageQueue } from "@fedify/sqlite";
import { avatar } from "./avatar.ts";
import { type BotConfig, cfg } from "./config.ts";
import {
  FOOTER_CSS,
  fedwerkUrl,
  OPERATOR_HANDLE,
  OPERATOR_URL,
  QUESTIONS_HANDLE,
  QUESTIONS_URL,
} from "./footer.ts";
import { catalogueFor } from "./strings.ts";

// Hides enqueueMany(): in @fedify/sqlite (2.3 to 2.4.4) it nests transactions and throws.
// `consume: false` stops the CLI's queue workers from stealing the running bot's mentions.
function queue(
  db: DatabaseSync,
  tableName: string,
  concurrency: number,
  consume: boolean,
): MessageQueue {
  const inner = new ParallelMessageQueue(
    new SqliteMessageQueue(db, { tableName, pollInterval: { seconds: 2 } }),
    concurrency,
  );
  return {
    nativeRetrial: inner.nativeRetrial,
    enqueue: (message, options) => inner.enqueue(message, options),
    listen: consume ? (handler, options) => inner.listen(handler, options) : async () => {},
  };
}

export type BotBinding = { readonly config: BotConfig; readonly bot: Bot<void> };

/** `consumeQueues: false` is for the CLI: it enqueues, the running bot delivers. */
export function buildInstance(db: DatabaseSync, { consumeQueues = true } = {}) {
  // ParallelMessageQueue (in queue()) is the only backpressure: without it a fan-out to
  // 3000 followers spawns 3000 concurrent deliveries. A restart mid fan-out loses some.
  const delivery = queue(db, "fedify_outbox", cfg.deliveryConcurrency, consumeQueues);
  const inbox = queue(db, "fedify_inbox", cfg.inboxConcurrency, consumeQueues);

  const instance = createInstance<void>({
    kv: new SqliteKvStore(db, { tableName: "fedify_kv" }),
    // Own file: SqliteRepository's connection has busy_timeout 0, so sharing app.db
    // would make any write contention throw out of session.publish().
    repository: new SqliteRepository({ path: cfg.botDbPath }),
    // Split so a fan-out never queues ahead of mentions. BotKit types a single queue
    // but passes it to Fedify untouched, which accepts the split form.
    queue: {
      inbox,
      outbox: delivery,
      fanout: delivery,
    } satisfies FederationQueueOptions as unknown as MessageQueue,
    // Without it /.well-known/nodeinfo answers with an empty link list.
    software: {
      name: "fediverse-wrapped",
      version: "1.0.0",
      repository: new URL(cfg.sourceUrl),
      homepage: new URL(cfg.origin),
    },
    // No behindProxy: http.ts already pins every request to ORIGIN.
    // Footer markup is added in pages.ts; BotKit only takes the styles.
    pages: { color: "green", theme: "auto", css: FOOTER_CSS },
  });

  const bots: BotBinding[] = cfg.bots.map((config) => {
    const catalogue = catalogueFor(config.locale);
    const sibling = cfg.bots.find((bot) => bot.handle !== config.handle);
    const siblingHandle = sibling == null ? "" : `@${sibling.handle}@${cfg.canonicalHost}`;

    const properties: Record<string, Text<"block" | "inline", void>> = {
      [catalogue.propLanguage]: plainText(catalogue.propLanguageValue),
      [catalogue.propAlsoIn]: plainText(siblingHandle),
      // AGPL section 13: network users must be able to get the source.
      [catalogue.propSource]: text`${new URL(cfg.sourceUrl)}`,
      [catalogue.propOperator]: text`54 Grad Software GmbH (${link(OPERATOR_HANDLE, OPERATOR_URL)})`,
    };

    return {
      config,
      // FROZEN FOREVER once federated: the handle is part of every actor and object URI.
      bot: instance.createBot(config.handle, {
        class: Service,
        username: config.handle,
        name: cfg.testingMode ? catalogue.botNameBeta : catalogue.botName,
        summary: catalogue.botSummary(
          siblingHandle,
          link(QUESTIONS_HANDLE, QUESTIONS_URL),
          link("FedWerk", fedwerkUrl(config.locale)),
        ),
        icon: avatar(),
        // The bot never follows back; see the assertion in main.ts.
        followerPolicy: "accept",
        properties,
      }),
    };
  });

  return { instance, bots };
}
