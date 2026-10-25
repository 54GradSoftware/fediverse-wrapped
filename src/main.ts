// Fediverse Wrapped.

import { mkdir, unlink } from "node:fs/promises";
import {
  configure,
  getConsoleSink,
  getJsonLinesFormatter,
  getLogger,
} from "@logtape/logtape";
import { serve } from "srvx";
import { cfg } from "./config.ts";
import { openDb } from "./db.ts";
import { makeMentionHandler } from "./handlers.ts";
import { createFetchHandler } from "./http.ts";
import { buildInstance } from "./instance.ts";
import { HostLimiter } from "./limiter.ts";
import { startWorkers } from "./worker.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

await configure({
  sinks: {
    console:
      cfg.logFormat === "json"
        ? getConsoleSink({ formatter: getJsonLinesFormatter() })
        : getConsoleSink(),
  },
  loggers: [
    { category: "wrapped", sinks: ["console"], lowestLevel: cfg.logLevel },
    { category: "botkit", sinks: ["console"], lowestLevel: "info" },
    { category: "fedify", sinks: ["console"], lowestLevel: cfg.fedifyLogLevel },
    { category: ["logtape", "meta"], sinks: ["console"], lowestLevel: "error" },
  ],
});

const logger = getLogger(["wrapped", "main"]);

// Our tables exist before Fedify and BotKit open the same file.
const db = await openDb(cfg.appDbPath, cfg.actorSalt);
await db.migrate();
await mkdir(cfg.imageDir, { recursive: true });

const { instance, bots } = buildInstance(db.fedify);
const mentionHandler = makeMentionHandler(db);
for (const { bot } of bots) bot.onMention = mentionHandler;

const controller = new AbortController();
const limiter = new HostLimiter();

const sessions = new Map(
  bots.map(({ config, bot }) => [
    config.identifier,
    bot.getSession(cfg.origin),
  ]),
);
const getSession = async (identifier: string) => {
  const session = sessions.get(identifier);
  if (session == null) throw new Error(`no session for bot ${identifier}`);
  return session;
};

// getDocumentLoader() SILENTLY falls back to unsigned without an RSA key pair, and every
// authorized-fetch instance would answer 401. Checked once, loudly.
for (const { config } of bots) {
  const session = await getSession(config.identifier);
  const keyPairs = await session.context.getActorKeyPairs(config.identifier);
  // ActorKeyPair extends the DOM lib's global CryptoKeyPair, invisible under @types/node.
  type KeyPairShape = { privateKey: { algorithm: { name: string } } };
  const hasRsa = keyPairs.some(
    (pair) =>
      (pair as unknown as KeyPairShape).privateKey.algorithm.name ===
      "RSASSA-PKCS1-v1_5",
  );
  if (!hasRsa) {
    throw new Error(
      `bot ${config.identifier} has no RSA key pair; signed fetches would silently fall back ` +
        "to unsigned and every authorized-fetch instance would refuse us",
    );
  }
  // Never follow on our own: Mastodon would serve followers-only posts into a public image.
  // The only follow() is in src/cli.ts, TESTING_MODE only; test/invariants.test.ts guards it.
}

if (cfg.testingMode) {
  logger.warn(
    "TESTING MODE (closed beta): the bots answer only direct messages from accounts they follow; add one with `node ace follow @user@host`",
  );
}

const recovered = await db.recoverAfterCrash(Date.now());
if (recovered.requeued > 0 || recovered.abandoned > 0) {
  // 'publishing' jobs are abandoned, never retried: the reply may already be out.
  logger.warn(
    "recovered after restart: {requeued} requeued, {abandoned} abandoned",
    recovered,
  );
}

const server = serve({
  fetch: createFetchHandler(db, (request) => instance.fetch(request)),
  port: cfg.port,
  hostname: "::",
});
await server.ready();

// Fedify starts queue workers lazily. Starting eagerly drains leftovers after a restart
// and is the only way to pass an abort signal.
void instance.federation
  .startQueue(undefined, { signal: controller.signal })
  .catch((error) => logger.error("queue workers failed: {error}", { error }));

void startWorkers(
  { db, bots, getSession, limiter },
  cfg.workers,
  controller.signal,
);

async function prune(): Promise<void> {
  try {
    const now = Date.now();
    const expired = await db.expiredImages(
      now - cfg.imageRetentionDays * DAY_MS,
    );
    for (const id of expired) {
      await unlink(`${cfg.imageDir}/${id}.png`).catch(() => undefined);
    }
    await db.deleteImages(expired);
    const jobs = await db.pruneJobs(now - cfg.jobRetentionDays * DAY_MS);
    const ledger = await db.pruneLedger(now - cfg.ledgerRetentionDays * DAY_MS);
    logger.info("pruned {images} images, {jobs} jobs, {ledger} ledger rows", {
      images: expired.length,
      jobs,
      ledger,
    });
  } catch (error) {
    logger.error("prune failed: {error}", { error });
  }
}
await prune();
const pruneTimer = setInterval(() => void prune(), DAY_MS);

// Logged first so a wrong ORIGIN is obvious in Coolify.
for (const { config } of bots) {
  // One pre-formatted value: the text formatter would quote each interpolated string.
  logger.info("serving {handle}", {
    handle: `@${config.username}@${cfg.canonicalHost} (${config.locale})`,
  });
}
logger.info("listening on :{port} for {origin}", {
  port: cfg.port,
  origin: cfg.origin,
});

let shuttingDown = false;
for (const signalName of ["SIGTERM", "SIGINT"] as const) {
  process.on(signalName, () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    logger.info("{signal} received, shutting down", { signal: signalName });
    // Deliberately no drain: a six minute job outlasts the grace period anyway.
    // Boot recovery re-queues it.
    clearInterval(pruneTimer);
    controller.abort();
    void server
      .close(false)
      .catch(() => undefined)
      .finally(async () => {
        await db.close().catch(() => undefined);
        process.exit(0);
      });
  });
}

// An unawaited promise somewhere. Exit rather than continue in an unknown state;
// Coolify restarts us.
process.on("unhandledRejection", (reason) => {
  logger.fatal("unhandled rejection, exiting: {reason}", { reason });
  process.exit(1);
});
