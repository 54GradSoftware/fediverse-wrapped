// The slow path: claim, resolve actor, walk outbox, compute stats, render, publish.

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { AuthorizedMessage, Session, SessionPublishOptions } from "@fedify/botkit";
import { Image, link, text } from "@fedify/botkit";
import { type Actor, getActorHandle, isActor, type Note } from "@fedify/vocab";
import { type DocumentLoader, getDocumentLoader } from "@fedify/vocab-runtime";
import { getLogger } from "@logtape/logtape";
import { cfg, type Locale, localeFor } from "./config.ts";
import { type Db, dayKey, type Job } from "./db.ts";
import { QUESTIONS_HANDLE, QUESTIONS_URL } from "./footer.ts";
import type { BotBinding } from "./instance.ts";
import { type HostLimiter, throttled } from "./limiter.ts";
import { softwareOf, WITHOUT_OUTBOX } from "./nodeinfo.ts";
import {
  classifyFetchError,
  type FailureKind,
  type Loaders,
  OutboxError,
  openOutbox,
  plausible,
  readAccount,
  type WalkProgress,
  walkOutbox,
} from "./outbox.ts";
import { computeStats, type Post, type Stats } from "./stats.ts";
import { type Block, type Catalogue, catalogueFor } from "./strings.ts";
import { renderTiles, SIZE, STARTER_THRESHOLD, tilePosts } from "./tiles.ts";

const logger = getLogger(["wrapped", "worker"]);

const IDLE_MS = 1_000;
/** Before attempts 2 and 3. Ten minutes outlast the limiter's ten-minute circuit breaker. */
const RETRY_DELAYS_MS = [60_000, 10 * 60_000] as const;

const USER_AGENT = `${cfg.userAgent} (+${cfg.origin})`;

export type WorkerDeps = {
  readonly db: Db;
  readonly bots: readonly BotBinding[];
  readonly getSession: (identifier: string) => Promise<Session<void>>;
  readonly limiter: HostLimiter;
  readonly now?: () => Date;
};

/** Resolves when every worker loop has observed the abort signal and stopped. */
export async function startWorkers(
  deps: WorkerDeps,
  count: number,
  signal: AbortSignal,
): Promise<void> {
  await Promise.all(
    Array.from({ length: count }, (_value, index) => runLoop(deps, index, signal)),
  );
}

async function runLoop(deps: WorkerDeps, index: number, signal: AbortSignal): Promise<void> {
  logger.debug("worker {index} started", { index });
  while (!signal.aborted) {
    let job: Job | null = null;
    try {
      job = await deps.db.claimJob(Date.now());
    } catch (error) {
      logger.error("claim failed: {error}", { error });
    }
    if (job == null) {
      // Rejects on abort, which only ends the wait; the loop condition stops.
      await sleep(IDLE_MS, undefined, { signal }).catch(() => undefined);
      continue;
    }
    try {
      await runJob(deps, job);
    } catch (error) {
      // runJob handles its own errors; anything here is a bug in runJob itself.
      logger.error("job {id} crashed: {error}", { id: job.message_id, error });
      await markCrashed(deps.db, job, error);
    }
  }
  logger.debug("worker {index} stopped", { index });
}

// Signed first, unlike the outbox: actors are not per-viewer and authorized fetch needs it.
// lookupObject() returns null on fetch errors, so the loader is wrapped to see transient ones.
export async function resolveActor(
  session: Session<void>,
  actorId: string,
  loaders: Loaders,
): Promise<Actor> {
  const failures: OutboxError[] = [];
  for (const documentLoader of [loaders.signed, loaders.unsigned]) {
    let failure: unknown = null;
    const watched: DocumentLoader = (url, options) =>
      documentLoader(url, options).catch((error: unknown) => {
        failure = error;
        throw error;
      });
    const object = await session.context
      .lookupObject(actorId, { documentLoader: watched })
      .catch((error: unknown) => {
        failure ??= error;
        return null;
      });
    if (isActor(object)) return object;
    if (failure != null) failures.push(classifyFetchError(failure, "actor fetch failed"));
  }
  // Either attempt hitting a transient failure means we do not know yet.
  const transient = failures.find((failure) => failure.transient);
  if (transient != null) throw transient;
  throw failures[0] ?? new OutboxError("outboxGone", false, "actor document is not an actor");
}

async function makeLoaders(deps: WorkerDeps, session: Session<void>, bot: string) {
  return {
    unsigned: throttled(
      getDocumentLoader({ userAgent: USER_AGENT, maxRedirection: 5 }),
      deps.limiter,
    ),
    signed: throttled(
      await session.context.getDocumentLoader({ identifier: bot }),
      deps.limiter,
    ),
  } satisfies Loaders;
}

/** Skips items with impossible timestamps before they can distort a stat. */
async function* plausibleOnly(posts: AsyncIterable<Post>, now: Date): AsyncIterable<Post> {
  for await (const post of posts) if (plausible(post, now)) yield post;
}

async function runJob(deps: WorkerDeps, job: Job): Promise<void> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const locale = localeFor(job.bot);
  const catalogue = catalogueFor(locale);
  const day = dayKey(new Date(job.created_at), cfg.rateLimitTimeZone);

  let actor: Actor | null = null;
  // Once true, the post may be out: no retry and no failure reply any more.
  let publishing = false;

  try {
    // Inside the try on purpose: a failing key-pair or KV read (busy botkit.db) must
    // still be retried or answered.
    const session = await deps.getSession(job.bot);
    const loaders = await makeLoaders(deps, session, job.bot);

    if (deps.limiter.isBlocked(job.host)) {
      throw new OutboxError("hostUnavailable", true, `circuit open for ${job.host}`);
    }

    actor = await resolveActor(session, job.actor_id, loaders);

    const { outbox, loader } = await openOutbox(actor, loaders);
    const account = await readAccount(actor, loader, (resolved) =>
      getActorHandle(resolved, { trimLeadingAt: true, punycode: true, userAgent: USER_AGENT }),
    );
    const progress: WalkProgress = {
      partial: false,
      pages: 0,
      itemsSeen: 0,
      itemsSkipped: 0,
      dereferenced: 0,
    };

    const counted = await computeStats(
      plausibleOnly(walkOutbox(actor, outbox, loader, progress, now), now),
      account,
      {
        from: new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000),
        to: now,
        timeZone: job.time_zone,
        tzExplicit: job.tz_explicit === 1,
      },
    );
    // Read only now: the walk sets it while computeStats consumes the posts.
    const stats: Stats = { ...counted, partial: progress.partial };

    if (stats.posts === 0) {
      // Distinct answers for an empty outbox, unreadable entries and no posts in the window.
      const nothingRead =
        progress.itemsSeen === 0 || progress.itemsSkipped === progress.itemsSeen;
      if (nothingRead && actor.id != null) {
        // Pixelfed, Lemmy and others keep posts out of the outbox, so "post something
        // public" would be wrong advice for them.
        const software = await softwareOf(actor.id.origin, USER_AGENT);
        const name = software == null ? undefined : WITHOUT_OUTBOX[software];
        if (name != null) {
          throw new OutboxError(
            "outboxNotPublished",
            false,
            `${software} serves no readable outbox`,
            name,
          );
        }
      }
      if (progress.itemsSeen === 0) throw new OutboxError("noPostsEver", false, "empty outbox");
      if (progress.itemsSkipped === progress.itemsSeen) {
        throw new OutboxError("outboxUnreadable", false, "no readable items");
      }
      throw new OutboxError("noPostsInWindow", false, "no posts in the last 365 days");
    }

    const tiles = await renderTiles(stats, locale, cfg.fontDir).catch((error) => {
      logger.warn("tile rendering failed, falling back to text: {error}", { error });
      return [];
    });

    const attachments: Image[] = [];
    for (const tile of tiles) {
      const id = randomUUID();
      await writeFile(`${cfg.imageDir}/${id}.png`, tile.png);
      await db.recordImage(id, job.actor_hash, Date.now());
      attachments.push(
        new Image({
          mediaType: "image/png",
          url: new URL(`/i/${id}.png`, cfg.origin),
          // `name` is the alt text; Mastodon reads it from here.
          name: tile.alt,
          width: SIZE,
          height: SIZE,
        }),
      );
    }
    // Mastodon shows at most four attachments per post, so eight tiles ship as a thread of two.
    const groups = tilePosts(attachments);

    // Built before markPublishing(), so nothing between it and the publish can throw.
    const share = job.visibility === "direct" ? catalogue.dmTail() : catalogue.shareTail();
    // The tiles disclose partial data too, but clients that hide media show only this text.
    const disclosed = stats.partial ? text`${catalogue.partialLine}\n\n${share}` : share;
    const tail = job.tz_explicit === 1 ? disclosed : text`${disclosed} ${catalogue.tzHintLine}`;
    const body =
      stats.posts < STARTER_THRESHOLD
        ? catalogue.successStarter(actor, tail)
        : catalogue.success(actor, stats.timeZone, tail);

    // Marked BEFORE publishing: a crash in between loses one reply, while marking after would
    // post a second wrapped on retry. Losing one silently beats duplicating one visibly.
    if (!(await db.markPublishing(job.message_id))) {
      logger.warn("job {id} taken by another loop", { id: job.message_id });
      return;
    }
    publishing = true;

    // From here nothing may reach failJob: publish() can throw after BotKit stored the post
    // (busy botkit.db during the fan-out enqueue).
    let published: AuthorizedMessage<Note, void>;
    try {
      published = await session.publish(body, {
        visibility: job.visibility,
        language: locale,
        attachments: groups[0] ?? [],
        // Undeclared on SessionPublishOptions but honoured by session-impl; BotKit is pinned
        // exactly for this, and the warning below fires if a version stops honouring it.
        replyTarget: { id: new URL(job.message_id), actor },
      } as SessionPublishOptions<void>);
    } catch (error) {
      logger.error("publishing failed for {hash}; not retried: {error}", {
        hash: job.actor_hash.slice(0, 12),
        error,
      });
      await markCrashed(db, job, error);
      return;
    }

    if (published.raw.replyTargetId == null) {
      logger.warn("BotKit no longer honours replyTarget; wrapped posted unthreaded");
    }

    // Remaining tiles reply to the first post and mention the actor again: without a Mention
    // tag a direct message reaches nobody.
    for (const group of groups.slice(1)) {
      await published
        .reply(catalogue.secondPost(actor, share), {
          visibility: job.visibility,
          language: locale,
          attachments: group,
        })
        .catch((error) => {
          // Half a wrapped is still a wrapped; the first post is already out.
          logger.warn("follow-up post failed: {error}", { error });
        });
    }

    const replyUri = published.id.href;
    try {
      await db.finishJob(job.message_id, "done", "ok", Date.now(), replyUri);
      await db.setReplyOutcome(job.actor_hash, day, "ok", replyUri);
    } catch (error) {
      // The wrapped is out; left in 'publishing', the next boot abandons it, never retries.
      logger.error("wrapped for {hash} is out but was not recorded: {error}", {
        hash: job.actor_hash.slice(0, 12),
        error,
      });
      return;
    }
    logger.info(
      "published wrapped for {hash}: {posts} posts, {pages} pages, {tiles} tiles in {msgs} post(s), partial={partial}",
      {
        hash: job.actor_hash.slice(0, 12),
        posts: stats.posts,
        pages: progress.pages,
        tiles: tiles.length,
        msgs: groups.length,
        partial: progress.partial,
      },
    );
  } catch (error) {
    if (publishing) {
      // failJob() cannot requeue a 'publishing' job and would leave it holding the host slot.
      logger.error("job {id} failed after publishing began: {error}", {
        id: job.message_id,
        error,
      });
      await markCrashed(db, job, error);
    } else {
      await failJob(deps, job, day, locale, error, actor);
    }
  }
}

/** Same verdict recoverAfterCrash() gives 'publishing': no retry and no failure reply. */
async function markCrashed(db: Db, job: Job, error: unknown): Promise<void> {
  try {
    await db.finishJob(
      job.message_id,
      "failed",
      "crashed",
      Date.now(),
      undefined,
      String(error),
    );
  } catch {
    // Left as it was: the next boot abandons it the same way.
  }
}

// Remote failures arrive as OutboxError. Anything else is ours (busy DB, full disk, bug): it is
// retried like an outage, and the final reply blames us, never the user's server.
export function jobFailure(error: unknown): OutboxError {
  if (error instanceof OutboxError) return error;
  return new OutboxError("internalError", true, `wrapped failed: ${String(error)}`);
}

async function failJob(
  deps: WorkerDeps,
  job: Job,
  day: string,
  locale: Locale,
  error: unknown,
  actor: Actor | null,
): Promise<void> {
  const { db } = deps;
  const failure = jobFailure(error);

  // Transient: two more attempts, each after a pause so they do not hit the same outage.
  if (failure.transient && job.attempts < 3) {
    const delayMs = RETRY_DELAYS_MS[job.attempts - 1] ?? RETRY_DELAYS_MS[1];
    const requeued = await db.requeueJob(
      job.message_id,
      failure.message.slice(0, 500),
      Date.now() + delayMs,
    );
    if (!requeued) {
      logger.warn("job {id} left running before its retry; not requeued", {
        id: job.message_id,
      });
      return;
    }
    logger.info("retrying {id} after {kind} in {seconds}s", {
      id: job.message_id,
      kind: failure.kind,
      seconds: delayMs / 1000,
    });
    return;
  }

  // Giving up. Transient failures hand the day back (a passing 429 must not cost it); a
  // deterministic one keeps the claim, as retries against a dead server help nobody.
  if (failure.transient) await db.releaseReply(job.actor_hash, day);
  else await db.setReplyOutcome(job.actor_hash, day, failure.kind);

  logger.warn("wrapped failed for {hash}: {kind} ({message})", {
    hash: job.actor_hash.slice(0, 12),
    kind: failure.kind,
    message: failure.message,
  });

  try {
    await replyWithFailure(deps, job, locale, failure.kind, actor, failure.detail);
  } catch (replyError) {
    logger.error("failure reply failed too: {error}", { error: replyError });
  }
  await db.finishJob(
    job.message_id,
    "failed",
    failure.kind,
    Date.now(),
    undefined,
    failure.message,
  );
}

async function replyWithFailure(
  deps: WorkerDeps,
  job: Job,
  locale: Locale,
  kind: FailureKind,
  known: Actor | null,
  detail?: string,
): Promise<void> {
  const session = await deps.getSession(job.bot);
  const catalogue = catalogueFor(locale);

  // Reuse the resolved actor or look it up again: a mention always deserves an answer.
  let actor = known;
  if (actor == null) {
    const loaders = await makeLoaders(deps, session, job.bot);
    actor = await resolveActor(session, job.actor_id, loaders).catch(() => null);
  }
  if (actor == null) {
    logger.error("cannot address {hash}; no failure reply sent", {
      hash: job.actor_hash.slice(0, 12),
    });
    return;
  }

  await session.publish(failureReply(catalogue, kind, actor, detail), {
    visibility: job.visibility,
    language: locale,
    replyTarget: { id: new URL(job.message_id), actor },
  } as SessionPublishOptions<void>);
}

function failureReply(
  catalogue: Catalogue,
  kind: FailureKind,
  actor: Actor,
  detail: string | undefined,
): Block {
  switch (kind) {
    case "outboxNotPublished":
      return detail == null
        ? catalogue.outboxUnavailable(actor)
        : catalogue.outboxNotPublished(actor, detail);
    case "internalError":
      return catalogue.internalError(actor, link(QUESTIONS_HANDLE, QUESTIONS_URL));
    case "noPostsEver":
    case "noPostsInWindow":
    case "outboxForbidden":
    case "outboxGone":
    case "outboxUnreadable":
    case "outboxUnavailable":
    case "rateLimited":
    case "hostUnavailable":
      return catalogue[kind](actor);
  }
}
