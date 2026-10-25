// Untrusted data: same-origin https checked BEFORE each request, budgets per page and item,
// output via clean(). SSRF, redirect and size limits are Fedify's: never disable them.

import {
  type Actor,
  Announce,
  Article,
  Object as ASObject,
  type Collection,
  type CollectionPage,
  Create,
  Document,
  Hashtag,
  Mention,
  PUBLIC_COLLECTION,
} from "@fedify/vocab";
import type { DocumentLoader } from "@fedify/vocab-runtime";
import { decode } from "html-entities";
import { HostRateLimitedError, statusOf } from "./limiter.ts";
import type { Account, Post } from "./stats.ts";

/** Stop after this many pages, whatever they contain. 120 x 20 = 2400 posts. */
export const MAX_PAGES = 200;
export const MAX_ITEMS = 4000;
export const TIME_BUDGET_MS = 6 * 60_000;
/** Consecutive pages with nothing usable before we give up on the collection. */
const MAX_EMPTY_PAGES = 5;
// Stale items tolerated past the cutoff: pinned and edited posts arrive out of order.
const CUTOFF_GRACE = 40;
// Fedify-based servers (Hackers' Pub) reference the Note by IRI, one request per post.
// This caps those fetches per walk; past it, references are skipped and marked partial.
export const MAX_DEREFERENCES = 150;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
// Hostile-post guard only: group replies really mention 50 people, so keep it far above.
const MAX_TAGS_PER_POST = 50;

export type FailureKind =
  | "noPostsEver"
  | "noPostsInWindow"
  | "outboxForbidden"
  | "outboxGone"
  | "outboxUnreadable"
  | "outboxNotPublished"
  | "outboxUnavailable"
  | "rateLimited"
  | "hostUnavailable"
  /** Not the remote server at all: our database, our disk or our code. */
  | "internalError";

export class OutboxError extends Error {
  readonly kind: FailureKind;
  /** Transient failures give the user their daily attempt back. */
  readonly transient: boolean;
  /** What the reply may name, e.g. the software behind `outboxNotPublished`. */
  readonly detail: string | undefined;

  constructor(
    kind: FailureKind,
    transient: boolean,
    message: string,
    detail?: string,
  ) {
    super(message);
    this.name = "OutboxError";
    this.kind = kind;
    this.transient = transient;
    this.detail = detail;
  }
}

export function classifyFetchError(
  error: unknown,
  fallbackMessage: string,
): OutboxError {
  if (error instanceof OutboxError) return error;
  if (error instanceof HostRateLimitedError) {
    return new OutboxError(
      "rateLimited",
      true,
      `${fallbackMessage}: ${error.message}`,
    );
  }
  const status = statusOf(error);
  if (status === 401 || status === 403) {
    return new OutboxError(
      "outboxForbidden",
      false,
      `${fallbackMessage}: ${status}`,
    );
  }
  if (status === 404 || status === 410) {
    return new OutboxError(
      "outboxGone",
      false,
      `${fallbackMessage}: ${status}`,
    );
  }
  if (status === 429) {
    return new OutboxError("rateLimited", true, `${fallbackMessage}: 429`);
  }
  if (status != null && status >= 500) {
    return new OutboxError(
      "hostUnavailable",
      true,
      `${fallbackMessage}: ${status}`,
    );
  }
  // No status: an undici network error is a TypeError WITH a cause, worth retrying. Without
  // one, Fedify rejected the shape (Akkoma 3.20 `?page=true`): deterministic, not transient.
  if (
    error instanceof TypeError &&
    (error as { cause?: unknown }).cause == null
  ) {
    return new OutboxError(
      "outboxUnreadable",
      false,
      `${fallbackMessage}: ${error.message}`,
    );
  }
  return new OutboxError(
    "outboxUnavailable",
    true,
    `${fallbackMessage}: ${String(error)}`,
  );
}

// Not \p{Cf}: removing U+200D/U+200C breaks emoji ZWJ sequences and Arabic/Indic shaping.
const STRIP = /[\p{Cc}\p{Cs}​‎‏‪-‮⁠-⁤⁦-⁩﻿]/gu;

export function clean(value: string, maxLength = 500): string {
  // Slice before toWellFormed(), or the slice can re-create a lone surrogate.
  return value.replace(STRIP, "").slice(0, maxLength).toWellFormed().trim();
}

export function htmlToText(html: string): string {
  return (
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<[^>]*>/g, " ")
      // Decoded after the tags are gone, so a literal "&lt;p&gt;" never becomes markup.
      .replace(/&[#\w]+;/g, (entity) => decode(entity))
      .replace(/[ \t\u00a0]+/g, " ")
      .replace(/[ \t]*\n[ \t]*/g, "\n")
      .trim()
  );
}

/** Refuses to fetch, so a reference not embedded in the page is skipped. */
export const noFetch: DocumentLoader = (url) =>
  Promise.reject(new Error(`not embedded, refusing to fetch: ${url}`));

// Plume pages have no `id`, so Fedify's origin check drops every embedded item. The fetch
// URL was validated as the actor's origin before the request, so it serves as the id.
export function identified(loader: DocumentLoader): DocumentLoader {
  return async (url) => {
    const doc = await loader(url);
    const body = doc.document;
    if (body == null || typeof body !== "object" || Array.isArray(body))
      return doc;
    if ("id" in body || "@id" in body) return doc;
    return { ...doc, document: { ...body, id: doc.documentUrl } };
  };
}

export type Loaders = {
  /** Used first: Mastodon then applies its own public-only query. */
  readonly unsigned: DocumentLoader;
  /** Used only after a 401/403; GoToSocial and secure-mode instances need it. */
  readonly signed: DocumentLoader;
};

export type WalkProgress = {
  /** True when a budget stopped the walk, so every count is a lower bound. */
  partial: boolean;
  pages: number;
  itemsSeen: number;
  /** Items that existed but were not public or not parseable. */
  itemsSkipped: number;
  /** Referenced objects fetched individually (see MAX_DEREFERENCES). */
  dereferenced: number;
};

const embedded = { documentLoader: noFetch, suppressError: true } as const;

function isPublic(item: { toIds: URL[]; ccIds: URL[] }): boolean {
  const audience = [...item.toIds, ...item.ccIds];
  return audience.some((uri) => uri.href === PUBLIC_COLLECTION.href);
}

// The handle comes from WebFinger: Mastodon's account domain may differ from the host
// serving the actor. Followers are best-effort; authorized-fetch servers may refuse.
export async function readAccount(
  actor: Actor,
  loader: DocumentLoader,
  handleOf: (actor: Actor) => Promise<string>,
): Promise<Account> {
  if (actor.id == null)
    throw new OutboxError("outboxGone", false, "actor has no id");
  let handle: string;
  try {
    handle = await handleOf(actor);
  } catch {
    handle = `${String(actor.preferredUsername ?? "?")}@${actor.id.host}`;
  }
  handle = clean(handle.replace(/^@/, ""), 64 + 1 + 253);

  let followers: number | null = null;
  // Same rule as the outbox: a collection on another server is not fetched.
  const followersId = actor.followersId;
  if (followersId != null && sameOriginHttps(followersId, actor.id.origin)) {
    try {
      followers =
        (await actor.getFollowers({ documentLoader: loader }))?.totalItems ??
        null;
    } catch {
      // Hidden or refused: the tile omits the row rather than claiming zero.
    }
  }

  const accountSince =
    actor.published == null
      ? null
      : new Date(actor.published.epochMilliseconds).toISOString().slice(0, 10);

  return { handle, followers, accountSince };
}

// Unsigned first is a privacy control: for an unsigned caller Mastodon itself enforces
// public-only. Signing happens only when the server demands it.
export async function openOutbox(
  actor: Actor,
  loaders: Loaders,
): Promise<{ outbox: Collection; loader: DocumentLoader }> {
  // Checked BEFORE the first request: an actor document can name any URL as its outbox.
  if (actor.id == null)
    throw new OutboxError("outboxGone", false, "actor has no id");
  const origin = actor.id.origin;
  const outboxId = actor.outboxId;
  if (outboxId != null && !sameOriginHttps(outboxId, origin)) {
    throw new OutboxError("outboxUnreadable", false, "outbox is off-origin");
  }

  const unsigned = identified(loaders.unsigned);
  const signed = identified(loaders.signed);
  // Root AND first page must load with the chosen loader: Akkoma 3.20 serves the root
  // unsigned but answers an unsigned `?page=true` with an empty non-page.
  const attempt = async (loader: DocumentLoader) => {
    const outbox = await actor.getOutbox({ documentLoader: loader });
    if (outbox == null) return null;
    // An off-origin first page is left unfetched; walkOutbox refuses it.
    if (outbox.firstId != null && sameOriginHttps(outbox.firstId, origin)) {
      // Only the shape is validated. Fedify memoises the page on the collection and the walk
      // reuses it, which is why the loaders are wrapped here.
      await outbox.getFirst({ documentLoader: loader });
    }
    return outbox;
  };

  let unsignedError: unknown = null;
  try {
    const outbox = await attempt(unsigned);
    if (outbox != null) return { outbox, loader: unsigned };
  } catch (error) {
    const status = statusOf(error);
    // A hard HTTP error other than "you need to sign" is final. A 401/403, a
    // null, or a shape error all mean: try again with a signature.
    if (status != null && status !== 401 && status !== 403) {
      throw classifyFetchError(error, "outbox fetch failed");
    }
    unsignedError = error;
  }

  try {
    const outbox = await attempt(signed);
    if (outbox != null) return { outbox, loader: signed };
  } catch (error) {
    throw classifyFetchError(error, "signed outbox fetch failed");
  }

  if (unsignedError != null)
    throw classifyFetchError(unsignedError, "outbox fetch failed");
  throw new OutboxError(
    "outboxUnreadable",
    false,
    "actor publishes no readable outbox",
  );
}

/** Yields the last year's public posts newest-first; a generator keeps memory flat. */
export async function* walkOutbox(
  actor: Actor,
  outbox: Collection,
  loader: DocumentLoader,
  progress: WalkProgress,
  now: Date,
): AsyncGenerator<Post> {
  if (actor.id == null) return;
  const origin = actor.id.origin;
  const cutoff = now.getTime() - YEAR_MS;
  const deadline = Date.now() + TIME_BUDGET_MS;
  const seenPages = new Set<string>();
  let staleRun = 0;
  let emptyRun = 0;
  /** Posts handed out so far; a page failure after the first one is survivable. */
  let yielded = 0;

  const opts = { documentLoader: loader };

  // Fetches a Create's referenced object: same-origin https only, within MAX_DEREFERENCES.
  const dereference = async (id: URL): Promise<ASObject | null> => {
    if (!sameOriginHttps(id, origin)) return null;
    if (progress.dereferenced >= MAX_DEREFERENCES) {
      progress.partial = true;
      return null;
    }
    progress.dereferenced++;
    try {
      const object = await loader(id.href).then((doc) =>
        ASObject.fromJsonLd(doc.document, { documentLoader: noFetch }),
      );
      return object instanceof ASObject ? object : null;
    } catch {
      return null;
    }
  };

  // One item against every per-item budget. Shared by the paged walk and an
  // inlined outbox, so a server cannot dodge the budgets by skipping `first`.
  const consider = async (
    item: unknown,
  ): Promise<Post | "skip" | "stale" | "stop"> => {
    if (++progress.itemsSeen > MAX_ITEMS || Date.now() > deadline) {
      progress.partial = true;
      return "stop";
    }
    const post = await toPost(item, origin, dereference);
    if (post == null) {
      progress.itemsSkipped++;
      return "skip";
    }
    if (post.createdAt.getTime() < cutoff) {
      return ++staleRun >= CUTOFF_GRACE ? "stop" : "stale";
    }
    staleRun = 0;
    return post;
  };

  const firstId = outbox.firstId;
  if (firstId != null && !sameOriginHttps(firstId, origin)) {
    throw new OutboxError(
      "outboxUnreadable",
      false,
      "outbox first page is off-origin",
    );
  }

  let page: CollectionPage | null;
  try {
    page = await outbox.getFirst(opts);
  } catch (error) {
    throw classifyFetchError(error, "outbox first page failed");
  }

  // A small outbox may inline its items with no first-page link at all.
  if (page == null) {
    for await (const item of outbox.getItems(embedded)) {
      const result = await consider(item);
      if (result === "stop") return;
      if (result === "skip" || result === "stale") continue;
      yielded++;
      yield result;
    }
    return;
  }

  while (page != null) {
    if (page.id != null) {
      // A `next` that points back at a page we already read would otherwise
      // loop until the item budget runs out.
      if (seenPages.has(page.id.href)) {
        progress.partial = true;
        return;
      }
      seenPages.add(page.id.href);
      if (!sameOriginHttps(page.id, origin)) {
        // Defence in depth: the next link was already checked before the fetch,
        // but a redirect could still land us somewhere else.
        progress.partial = true;
        return;
      }
    }
    if (++progress.pages > MAX_PAGES || Date.now() > deadline) {
      progress.partial = true;
      return;
    }

    let usable = 0;
    try {
      for await (const item of page.getItems(embedded)) {
        const result = await consider(item);
        if (result === "stop") return;
        if (result === "skip") continue;
        usable++;
        if (result === "stale") continue;
        yielded++;
        yield result;
      }
    } catch (error) {
      // A broken page truncates the walk; it does not fail the whole wrapped.
      // Only with nothing to keep does it fail, so the job can be retried.
      if (yielded > 0) {
        progress.partial = true;
        return;
      }
      throw classifyFetchError(error, "outbox page failed");
    }

    emptyRun = usable === 0 ? emptyRun + 1 : 0;
    if (emptyRun >= MAX_EMPTY_PAGES) {
      progress.partial = true;
      return;
    }

    // Validate the NEXT link before following it. Checking the page after
    // getNext() would mean the cross-origin request had already been sent.
    const nextId = page.nextId;
    if (nextId == null) return;
    if (!sameOriginHttps(nextId, origin) || seenPages.has(nextId.href)) {
      progress.partial = true;
      return;
    }
    try {
      page = await page.getNext(opts);
    } catch (error) {
      // A timeout or 429 deep into a busy year: keep what was read rather than
      // throw it away and re-walk every page against the same rate limit.
      if (yielded > 0) {
        progress.partial = true;
        return;
      }
      throw classifyFetchError(error, "outbox next page failed");
    }
  }
}

/** An outbox may not hand its pagination to another origin, or to plain http. */
function sameOriginHttps(uri: URL, origin: string): boolean {
  return uri.origin === origin && uri.protocol === "https:";
}

/** Normalises one outbox entry, or null when it is not a readable public post. */
async function toPost(
  item: unknown,
  origin: string,
  dereference: (id: URL) => Promise<ASObject | null>,
): Promise<Post | null> {
  if (item instanceof Announce) {
    if (item.published == null || !isPublic(item)) return null;
    // The boosted object is a bare URI everywhere we tested; fetching it costs a request.
    return {
      createdAt: new Date(item.published.epochMilliseconds),
      kind: "boost",
      tags: [],
      mentions: [],
      attachments: 0,
      attachmentsWithAlt: 0,
      hasCw: false,
      chars: 0,
      words: 0,
      likes: null,
      shares: null,
    };
  }
  if (!(item instanceof Create)) return null;

  let note: ASObject | null = null;
  try {
    const object = await item.getObject(embedded);
    if (object instanceof ASObject) note = object;
  } catch {
    // Not embedded: fall through to the bounded dereference below.
  }
  if (note == null && item.objectId != null)
    note = await dereference(item.objectId);
  if (note == null) return null;
  // An activity must not carry an object from somewhere else.
  if (note.id != null && note.id.origin !== origin) return null;

  const published = note.published ?? item.published;
  if (published == null) return null;
  // The Note's own addressing wins, so a public Create cannot carry a followers-only Note.
  // Only a Note with no addressing at all falls back to its Create's.
  const noteAddressed = note.toIds.length > 0 || note.ccIds.length > 0;
  if (!isPublic(noteAddressed ? note : item)) return null;

  const tags: string[] = [];
  const mentions: string[] = [];
  try {
    for await (const tag of note.getTags(embedded)) {
      if (
        tag instanceof Hashtag &&
        tag.name != null &&
        tags.length < MAX_TAGS_PER_POST
      ) {
        const text = clean(String(tag.name).replace(/^#/, ""), 60);
        if (text !== "") tags.push(text);
      } else if (
        tag instanceof Mention &&
        tag.name != null &&
        mentions.length < MAX_TAGS_PER_POST
      ) {
        let handle = clean(
          String(tag.name).replace(/^@/, ""),
          200,
        ).toLowerCase();
        // Same-server mentions are serialised without a domain; qualify them
        // from the href so the distinct-account count is not inflated.
        if (!handle.includes("@") && tag.href != null)
          handle = `${handle}@${tag.href.host}`;
        if (handle !== "") mentions.push(handle);
      }
    }
  } catch {
    // Tags referenced remotely: keep whatever was embedded.
  }

  let attachments = 0;
  let attachmentsWithAlt = 0;
  try {
    for await (const attachment of note.getAttachments(embedded)) {
      // Mastodon files link previews under `attachment` as bare `Link`s; real media (Image,
      // Video, Audio) extend Document. Counting previews skewed the alt-text rate.
      if (!(attachment instanceof Document)) continue;
      // Capped before counting, so a fully described 25-image post stays
      // 20 of 20 rather than 20 of 21 and keeps its alt-text credit.
      if (attachments === 20) break;
      attachments++;
      // Mastodon documents `attachment[].summary` as the media description and
      // serialises its own descriptions as `name`; either counts as alt text.
      const alt = String(attachment.summary ?? attachment.name ?? "").trim();
      if (alt !== "") attachmentsWithAlt++;
    }
  } catch {
    // Attachments referenced remotely: counted as none.
  }

  let likes: number | null = null;
  let shares: number | null = null;
  try {
    likes = (await note.getLikes(embedded))?.totalItems ?? null;
  } catch {
    // Not published by this server (Misskey, Pleroma, …).
  }
  try {
    shares = (await note.getShares(embedded))?.totalItems ?? null;
  } catch {
    // As above.
  }

  const content = note.content == null ? "" : htmlToText(String(note.content));
  const summary = note.summary == null ? "" : String(note.summary).trim();

  return {
    createdAt: new Date(published.epochMilliseconds),
    kind: note.replyTargetIds.length > 0 ? "reply" : "post",
    tags: [...new Set(tags)],
    mentions: [...new Set(mentions)],
    attachments,
    attachmentsWithAlt,
    // `summary` is the CW (Mastodon, Misskey; `sensitive` alone is not one), but on an
    // Article (WriteFreely, Ghost, WordPress) it is the excerpt.
    hasCw: summary !== "" && !(note instanceof Article),
    // Code points of the full text, before truncation, so "longest post" cannot saturate.
    chars: [...content].length,
    words: content === "" ? 0 : content.split(/\s+/).filter(Boolean).length,
    likes,
    shares,
  };
}

/** Drops impossible timestamps; a post dated 2300 would win every "busiest month". */
export function plausible(post: Post, now: Date): boolean {
  const at = post.createdAt.getTime();
  if (!Number.isFinite(at)) return false;
  return at > Date.UTC(2006, 0, 1) && at < now.getTime() + 24 * 60 * 60 * 1000;
}
