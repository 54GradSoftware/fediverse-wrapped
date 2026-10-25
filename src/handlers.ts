// Inbox side: no network I/O. Validate, take the idempotency key and the daily ledger, then
// queue the job; src/worker.ts does everything slow.

import type { Message, MessageClass, Session } from "@fedify/botkit";
import { getLogger } from "@logtape/logtape";
import { assertTimeZone, cfg, type Locale, localeFor } from "./config.ts";
import { type Db, dayKey, type Visibility } from "./db.ts";
import { catalogueFor } from "./strings.ts";

const logger = getLogger(["wrapped", "mention"]);

/** Accepted triggers per remote host per window, before we start ignoring them. */
const HOST_TRIGGER_LIMIT = 30;
const HOST_TRIGGER_WINDOW_MS = 5 * 60_000;
/** Past this many tracked hosts, expired windows are swept before adding one. */
const HOST_TRIGGER_SWEEP_AT = 1024;

const triggers = new Map<string, { count: number; resetAt: number }>();

function hostBudgetOk(host: string, now: number): boolean {
  const entry = triggers.get(host);
  if (entry == null || entry.resetAt <= now) {
    if (entry == null && triggers.size >= HOST_TRIGGER_SWEEP_AT) {
      for (const [key, value] of triggers) {
        if (value.resetAt <= now) triggers.delete(key);
      }
    }
    triggers.set(host, { count: 1, resetAt: now + HOST_TRIGGER_WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= HOST_TRIGGER_LIMIT;
}

// "followers" would publish to the BOT's followers and "unknown" has unknown reach, so both
// are answered as a DM.
export function replyVisibility(visibility: string): Visibility {
  if (visibility === "public") return "public";
  if (visibility === "unlisted") return "unlisted";
  return "direct";
}

// `tz=Europe/Vienna` anywhere in the mention. Without it the tile names the default zone and
// clock-based archetypes are suppressed (see stats.ts).
export function parseTimeZone(
  body: string,
  fallback: string,
): { timeZone: string; explicit: boolean } {
  const match = /\btz\s*=\s*([A-Za-z]+(?:[_+-][A-Za-z0-9]+)*(?:\/[A-Za-z0-9_+-]+){0,2})/.exec(
    body,
  );
  if (match?.[1] == null) return { timeZone: fallback, explicit: false };
  const candidate = match[1];
  // Etc/GMT+5 has an inverted sign and confuses everyone who tries it.
  if (/^Etc\//i.test(candidate)) return { timeZone: fallback, explicit: false };
  try {
    assertTimeZone("tz", candidate);
    return { timeZone: candidate, explicit: true };
  } catch {
    return { timeZone: fallback, explicit: false };
  }
}

function languageOf(message: Message<MessageClass, void>): Locale {
  return message.language?.language === "en" ? "en" : "de";
}

export function makeMentionHandler(db: Db) {
  return async (
    session: Session<void>,
    message: Message<MessageClass, void>,
  ): Promise<void> => {
    // Nothing may escape: Fedify redelivers up to ten times on a throw, and a throw after
    // publishing would post the same wrapped again each time.
    try {
      await handleMention(db, session, message);
    } catch (error) {
      logger.error("mention handler failed: {error}", { error });
    }
  };
}

async function handleMention(
  db: Db,
  session: Session<void>,
  message: Message<MessageClass, void>,
): Promise<void> {
  const actorId = message.actor.id;
  if (actorId == null || message.id == null) return;

  // Our own bots (and the instance actor) mention each other in replies; left
  // unguarded that is a loop between wrapped_de and wrapped_en.
  if (actorId.host.toLowerCase() === cfg.canonicalHost) return;

  // Replies under our own wrapped ("thanks!") are dropped silently. Not `replyTarget == null`:
  // replying inside somebody else's thread is a normal way to summon the bot.
  if (message.replyTarget?.actor?.id?.href === session.actorId.href) return;

  // Testing mode: only a DM from an account on the test list (added by the operator with
  // `node ace follow`) gets any reaction; everything else is dropped silently. The list,
  // not session.follows(), so a tester need not accept the follow request first.
  if (cfg.testingMode && message.visibility !== "direct") {
    logger.info("testing mode: ignored a {visibility} mention from {hash}", {
      visibility: message.visibility,
      hash: db.hashActor(actorId.href).slice(0, 12),
    });
    return;
  }
  if (cfg.testingMode && !(await db.isTestAccount(session.bot.identifier, actorId.href))) {
    logger.info("testing mode: ignored a mention from {hash}", {
      hash: db.hashActor(actorId.href).slice(0, 12),
    });
    return;
  }

  // Both bots mentioned in one post: instance-impl runs every bot, so only the one matching
  // the post's language answers.
  const ourActorIds = new Set(
    cfg.bots.map((bot) => session.context.getActorUri(bot.handle).href),
  );
  const mentionsOfUs = message.mentions.filter(
    (mentioned) => mentioned.id != null && ourActorIds.has(mentioned.id.href),
  );
  const locale = localeFor(session.bot.identifier);
  if (mentionsOfUs.length > 1 && languageOf(message) !== locale) return;

  // A redelivery is not a new trigger. Checked before the budget, so Fedify's
  // retries cannot spend it and starve that host's genuine mentions.
  if (await db.hasJob(message.id.href)) {
    logger.debug("duplicate delivery ignored: {id}", { id: message.id.href });
    return;
  }

  const now = Date.now();
  if (!hostBudgetOk(actorId.host, now)) {
    logger.warn("host trigger budget exhausted: {host}", { host: actorId.host });
    return;
  }

  const botConfig = cfg.bots.find((bot) => bot.handle === session.bot.identifier);
  if (botConfig == null) return;
  const catalogue = catalogueFor(locale);
  const visibility = replyVisibility(message.visibility);
  const { timeZone, explicit } = parseTimeZone(message.text, botConfig.timeZone);

  const actorHash = db.hashActor(actorId.href);
  const day = dayKey(new Date(now), cfg.rateLimitTimeZone);

  // One transaction: dedupe before the rate limit so a redelivery is not refused, and claim
  // the day here, not in the worker, so mentioning both bots cannot cost two walks.
  const accepted = await db.acceptJob(
    {
      messageId: message.id.href,
      bot: session.bot.identifier,
      actorId: actorId.href,
      host: actorId.host,
      visibility,
      timeZone,
      tzExplicit: explicit,
      now,
    },
    day,
  );
  if (accepted === "duplicate") {
    logger.debug("duplicate delivery ignored: {id}", { id: message.id.href });
    return;
  }
  if (accepted === "overLimit") {
    await refuse(db, message, { actorHash, day, now, locale, visibility });
    return;
  }

  // A favourite lands within a second and tells the user they were heard, which
  // is what makes the queued acknowledgement genuinely optional.
  void message.like().catch(() => undefined);

  // Only acknowledge when the job will not start straight away. A fixed queue
  // depth would claim "it's busy" while the workers sit idle.
  const ahead = await db.jobsAhead(now);
  if (ahead >= cfg.workers && (await db.claimAck(message.id.href))) {
    await message
      .reply(catalogue.ackQueued(message.actor), { visibility, language: locale })
      .catch((error) => logger.warn("ack failed: {error}", { error }));
  }

  logger.info("queued wrapped for {hash} ({bot}), {ahead} ahead", {
    hash: actorHash.slice(0, 12),
    bot: session.bot.identifier,
    ahead,
  });
}

// acceptJob() already stored the job as rejected. The refusal is claimed once per account per
// day, which bounds a mention loop with another bot at two posts.
async function refuse(
  db: Db,
  message: Message<MessageClass, void>,
  {
    actorHash,
    day,
    now,
    locale,
    visibility,
  }: { actorHash: string; day: string; now: number; locale: Locale; visibility: Visibility },
): Promise<void> {
  if (!(await db.claimReply(actorHash, day, "refusal", now))) {
    logger.debug("second refusal suppressed for {hash}", { hash: actorHash.slice(0, 12) });
    return;
  }

  const catalogue = catalogueFor(locale);
  const previous = await db.todaysWrapped(actorHash, day);
  // No outcome usually means still queued or running, but a job that crashed while
  // publishing has none either and must not be promised as "on its way".
  const pending = previous?.outcome == null && (await db.hasOpenJob(actorHash));
  const body =
    previous?.outcome === "ok" && previous.reply_uri != null
      ? catalogue.dailyLimitOk(message.actor, new URL(previous.reply_uri))
      : pending
        ? catalogue.dailyLimitPending(message.actor)
        : catalogue.dailyLimitRetry(message.actor);

  await message
    .reply(body, { visibility, language: locale })
    .catch((error) => logger.warn("refusal failed: {error}", { error }));
}
