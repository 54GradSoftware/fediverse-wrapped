import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Person } from "@fedify/vocab";
import type { DocumentLoader } from "@fedify/vocab-runtime";
import {
  classifyFetchError,
  clean,
  htmlToText,
  MAX_DEREFERENCES,
  MAX_ITEMS,
  OutboxError,
  openOutbox,
  plausible,
  readAccount,
  type WalkProgress,
  walkOutbox,
} from "../src/outbox.ts";
import type { Post } from "../src/stats.ts";

const AS = "https://www.w3.org/ns/activitystreams";
const PUBLIC = `${AS}#Public`;
const ORIGIN = "https://x.test";
const ACTOR = `${ORIGIN}/users/a`;
const OUTBOX = `${ACTOR}/outbox`;
const NOW = new Date("2026-09-18T12:00:00Z");

/** Serves canned JSON-LD and counts every request, so we can assert on fetches. */
function loaderOf(docs: Record<string, unknown>) {
  const calls: string[] = [];
  const load: DocumentLoader = async (url) => {
    calls.push(url);
    const document = docs[url];
    if (document == null) {
      const error = new Error(`404 ${url}`) as Error & { response: Response };
      error.response = new Response("", { status: 404 });
      throw error;
    }
    return { contextUrl: null, document, documentUrl: url };
  };
  return { load, calls };
}

/** Sends one request through `loader` and reports whether `via` answered it. */
async function routesThrough(loader: DocumentLoader, via: { calls: string[] }, url = OUTBOX) {
  const before = via.calls.length;
  await loader(url).catch(() => null);
  return via.calls.length === before + 1 && via.calls[before] === url;
}

const actor = () =>
  new Person({ id: new URL(ACTOR), preferredUsername: "a", outbox: new URL(OUTBOX) });

function note(id: string, published: string, over: Record<string, unknown> = {}) {
  return {
    id: `${ORIGIN}/notes/${id}`,
    type: "Note",
    attributedTo: ACTOR,
    published,
    content: "<p>hello</p>",
    to: [PUBLIC],
    ...over,
  };
}

function create(id: string, published: string, over: Record<string, unknown> = {}) {
  return {
    id: `${ORIGIN}/act/${id}`,
    type: "Create",
    actor: ACTOR,
    published,
    to: [PUBLIC],
    object: note(id, published, over),
  };
}

function page(url: string, items: unknown[], next?: string) {
  return {
    "@context": AS,
    id: url,
    type: "OrderedCollectionPage",
    partOf: OUTBOX,
    orderedItems: items,
    ...(next == null ? {} : { next }),
  };
}

const root = (first: string) => ({
  "@context": AS,
  id: OUTBOX,
  type: "OrderedCollection",
  totalItems: 99,
  first,
});

async function collect(docs: Record<string, unknown>) {
  const { load, calls } = loaderOf(docs);
  const { outbox, loader } = await openOutbox(actor(), { unsigned: load, signed: load });
  const progress: WalkProgress = {
    partial: false,
    pages: 0,
    itemsSeen: 0,
    itemsSkipped: 0,
    dereferenced: 0,
  };
  const posts: Post[] = [];
  for await (const post of walkOutbox(actor(), outbox, loader, progress, NOW)) posts.push(post);
  return { posts, progress, calls };
}

describe("pagination shapes", () => {
  it("follows Mastodon-style max_id pages and reads engagement counts", async () => {
    const p1 = `${OUTBOX}?page=true`;
    const p2 = `${OUTBOX}?max_id=2&page=true`;
    const { posts } = await collect({
      [OUTBOX]: root(p1),
      [p1]: page(
        p1,
        [
          create("1", "2026-09-01T10:00:00Z", {
            likes: { type: "Collection", totalItems: 12 },
            shares: { type: "Collection", totalItems: 4 },
          }),
          {
            id: `${ORIGIN}/act/boost`,
            type: "Announce",
            actor: ACTOR,
            published: "2026-09-02T10:00:00Z",
            to: [PUBLIC],
            object: "https://elsewhere.test/notes/9",
          },
        ],
        p2,
      ),
      [p2]: page(p2, [create("3", "2026-08-01T10:00:00Z")]),
    });
    assert.equal(posts.length, 3);
    assert.equal(posts.filter((post) => post.kind === "boost").length, 1);
    assert.equal(posts[0]?.likes, 12);
    assert.equal(posts[0]?.shares, 4);
  });

  it("follows a cursor-style next link without reconstructing it", async () => {
    // Hollo uses ?cursor=N. Following `next` verbatim is what makes Mastodon,
    // Hollo, Misskey and Pleroma all work with one code path.
    const p1 = `${OUTBOX}?cursor=0`;
    const p2 = `${OUTBOX}?cursor=40`;
    const { posts, calls } = await collect({
      [OUTBOX]: root(p1),
      [p1]: page(p1, [create("1", "2026-09-01T10:00:00Z")], p2),
      [p2]: page(p2, [create("2", "2026-09-02T10:00:00Z")]),
    });
    assert.equal(posts.length, 2);
    assert.ok(calls.includes(p2), "must fetch the exact next URL it was given");
  });

  it("reports null engagement when the server publishes none", async () => {
    // Misskey and Pleroma do not serialise likes/shares at all.
    const p1 = `${OUTBOX}?page=true`;
    const { posts } = await collect({
      [OUTBOX]: root(p1),
      [p1]: page(p1, [create("1", "2026-09-01T10:00:00Z")]),
    });
    assert.equal(posts[0]?.likes, null);
    assert.equal(posts[0]?.shares, null);
  });

  it("reads a small outbox whose items are inlined with no first page", async () => {
    const { posts } = await collect({
      [OUTBOX]: {
        "@context": AS,
        id: OUTBOX,
        type: "OrderedCollection",
        totalItems: 1,
        orderedItems: [create("1", "2026-09-01T10:00:00Z")],
      },
    });
    assert.equal(posts.length, 1);
  });

  it("holds an inlined outbox to the same item cap as a paged one", async () => {
    const items = Array.from({ length: MAX_ITEMS + 5 }, (_value, index) =>
      create(String(index), "2026-09-01T10:00:00Z"),
    );
    const { posts, progress } = await collect({
      [OUTBOX]: {
        "@context": AS,
        id: OUTBOX,
        type: "OrderedCollection",
        totalItems: items.length,
        orderedItems: items,
      },
    });
    assert.equal(posts.length, MAX_ITEMS);
    assert.equal(progress.partial, true, "a truncated walk must say so on the tile");
  });

  it("stops an inlined outbox once it is past the year", async () => {
    const stale = Array.from({ length: 45 }, (_value, index) =>
      create(`old${index}`, "2024-01-01T10:00:00Z"),
    );
    const { posts, progress } = await collect({
      [OUTBOX]: {
        "@context": AS,
        id: OUTBOX,
        type: "OrderedCollection",
        totalItems: 47,
        orderedItems: [
          create("new", "2026-09-01T10:00:00Z"),
          ...stale,
          create("late", "2026-09-02T10:00:00Z"),
        ],
      },
    });
    assert.equal(posts.length, 1, "the walk ends inside the stale run");
    assert.equal(progress.itemsSeen, 41, "1 fresh item, then 40 stale ones");
  });
});

describe("hostile and broken collections", () => {
  it("stops when next points back at a page it already read", async () => {
    const p1 = `${OUTBOX}?page=true`;
    const { posts, progress } = await collect({
      [OUTBOX]: root(p1),
      [p1]: page(p1, [create("1", "2026-09-01T10:00:00Z")], p1),
    });
    assert.equal(posts.length, 1);
    assert.equal(progress.partial, true);
  });

  it("refuses a next link on a different origin", async () => {
    const p1 = `${OUTBOX}?page=true`;
    const evil = "https://evil.test/outbox?page=2";
    const { posts, calls } = await collect({
      [OUTBOX]: root(p1),
      [p1]: page(p1, [create("1", "2026-09-01T10:00:00Z")], evil),
      [evil]: page(evil, [create("2", "2026-09-02T10:00:00Z")]),
    });
    assert.equal(posts.length, 1);
    assert.equal(
      calls.some((call) => call.startsWith("https://evil.test")),
      false,
      "an outbox must not hand pagination to a third party",
    );
  });

  it("never requests an outbox on a different origin", async () => {
    const evil = "https://evil.test/outbox";
    const { load, calls } = loaderOf({ [evil]: root(`${evil}?page=true`) });
    const offOrigin = new Person({
      id: new URL(ACTOR),
      preferredUsername: "a",
      outbox: new URL(evil),
    });
    await assert.rejects(openOutbox(offOrigin, { unsigned: load, signed: load }), OutboxError);
    assert.deepEqual(calls, [], "not even the signed fallback may go there");
  });

  it("never requests a first page on a different origin", async () => {
    const evil = "https://evil.test/outbox?page=true";
    const { load, calls } = loaderOf({
      [OUTBOX]: root(evil),
      [evil]: page(evil, [create("1", "2026-09-01T10:00:00Z")]),
    });
    const { outbox, loader } = await openOutbox(actor(), { unsigned: load, signed: load });
    const progress: WalkProgress = {
      partial: false,
      pages: 0,
      itemsSeen: 0,
      itemsSkipped: 0,
      dereferenced: 0,
    };
    await assert.rejects(async () => {
      for await (const _post of walkOutbox(actor(), outbox, loader, progress, NOW)) {
        // drain
      }
    }, OutboxError);
    assert.equal(
      calls.some((call) => call.startsWith("https://evil.test")),
      false,
      "the first page must be refused before it is fetched",
    );
  });

  it("stops after a run of pages with nothing usable", async () => {
    const docs: Record<string, unknown> = { [OUTBOX]: root(`${OUTBOX}?p=0`) };
    for (let index = 0; index < 40; index++) {
      docs[`${OUTBOX}?p=${index}`] = page(
        `${OUTBOX}?p=${index}`,
        [],
        `${OUTBOX}?p=${index + 1}`,
      );
    }
    const { posts, progress } = await collect(docs);
    assert.equal(posts.length, 0);
    assert.equal(progress.partial, true);
    assert.ok(progress.pages <= 6, `gave up after ${progress.pages} empty pages`);
  });
});

describe("a page that fails partway through the walk", () => {
  it("keeps the posts already read and marks the result partial", async () => {
    // The next page 404s here, standing in for a timeout or 429 deep into a busy year.
    const p1 = `${OUTBOX}?page=true`;
    const { posts, progress } = await collect({
      [OUTBOX]: root(p1),
      [p1]: page(p1, [create("1", "2026-09-01T10:00:00Z")], `${OUTBOX}?page=2`),
    });
    assert.equal(posts.length, 1);
    assert.equal(progress.partial, true, "a truncated walk must be disclosed");
  });

  it("still fails when nothing usable was read before the failure", async () => {
    // Keeping an empty result would tell the user they never posted.
    const p1 = `${OUTBOX}?page=true`;
    await assert.rejects(
      collect({
        [OUTBOX]: root(p1),
        [p1]: page(p1, [create("1", "2024-01-01T10:00:00Z")], `${OUTBOX}?page=2`),
      }),
      OutboxError,
    );
  });
});

describe("servers that answer with the wrong shape", () => {
  it("switches to a signature when only the FIRST PAGE is broken unsigned (Akkoma 3.20)", async () => {
    // Akkoma 3.20 answers an unsigned ?page=true with an empty OrderedCollection and a signed
    // one with a real page, so the root alone cannot decide signed or unsigned.
    const p1 = OUTBOX + "?page=true";
    const good = page(p1, [create("1", "2026-09-01T10:00:00Z")]);
    const stub = { "@context": AS, id: p1, type: "OrderedCollection", orderedItems: [] };
    const unsigned = loaderOf({ [OUTBOX]: root(p1), [p1]: stub });
    const signed = loaderOf({ [OUTBOX]: root(p1), [p1]: good });
    const { outbox, loader } = await openOutbox(actor(), {
      unsigned: unsigned.load,
      signed: signed.load,
    });
    assert.ok(await routesThrough(loader, signed), "must fall through to the signed loader");
    const progress: WalkProgress = {
      partial: false,
      pages: 0,
      itemsSeen: 0,
      itemsSkipped: 0,
      dereferenced: 0,
    };
    const posts: Post[] = [];
    for await (const post of walkOutbox(actor(), outbox, loader, progress, NOW))
      posts.push(post);
    assert.equal(posts.length, 1);
  });

  it("reports an empty non-page as unreadable when even a signature does not help", async () => {
    // Both loaders get Akkoma's empty page; Fedify throws a TypeError without a status.
    // Treating that as transient made the bot retry three times and blame its network.
    const p1 = OUTBOX + "?page=true";
    const { load } = loaderOf({
      [OUTBOX]: root(p1),
      [p1]: { "@context": AS, id: p1, type: "OrderedCollection", orderedItems: [] },
    });
    await assert.rejects(
      () => openOutbox(actor(), { unsigned: load, signed: load }),
      (error: unknown) =>
        error instanceof OutboxError &&
        error.kind === "outboxUnreadable" &&
        error.transient === false,
    );
  });

  it("still treats a real network failure as transient", () => {
    const networkError = new TypeError("fetch failed");
    (networkError as { cause?: unknown }).cause = Object.assign(
      new Error("connect ECONNREFUSED"),
      {
        code: "ECONNREFUSED",
      },
    );
    const classified = classifyFetchError(networkError, "outbox fetch failed");
    assert.equal(classified.kind, "outboxUnavailable");
    assert.equal(classified.transient, true);
  });
});

describe("audience filtering", () => {
  const cases = [
    { name: "followers-only Create", to: [`${ACTOR}/followers`], cc: [] as string[] },
    { name: "direct message", to: ["https://y.test/users/b"], cc: [] as string[] },
  ];
  for (const { name, to, cc } of cases) {
    it(`drops a ${name}`, async () => {
      const p1 = `${OUTBOX}?page=true`;
      const { posts } = await collect({
        [OUTBOX]: root(p1),
        [p1]: page(p1, [
          {
            id: `${ORIGIN}/act/private`,
            type: "Create",
            actor: ACTOR,
            published: "2026-09-01T10:00:00Z",
            to,
            cc,
            object: note("private", "2026-09-01T10:00:00Z", { to, cc }),
          },
        ]),
      });
      assert.equal(posts.length, 0, "only as:Public items may ever be counted");
    });
  }

  it("keeps an unlisted post, which carries Public in cc", async () => {
    const p1 = `${OUTBOX}?page=true`;
    const audience = { to: [`${ACTOR}/followers`], cc: [PUBLIC] };
    const { posts } = await collect({
      [OUTBOX]: root(p1),
      [p1]: page(p1, [
        {
          id: `${ORIGIN}/act/unlisted`,
          type: "Create",
          actor: ACTOR,
          published: "2026-09-01T10:00:00Z",
          ...audience,
          object: note("unlisted", "2026-09-01T10:00:00Z", audience),
        },
      ]),
    });
    assert.equal(posts.length, 1);
  });

  it("drops a followers-only Note inside a public Create", async () => {
    const p1 = `${OUTBOX}?page=true`;
    const { posts } = await collect({
      [OUTBOX]: root(p1),
      [p1]: page(p1, [
        create("laundered", "2026-09-01T10:00:00Z", { to: [`${ACTOR}/followers`], cc: [] }),
      ]),
    });
    assert.equal(posts.length, 0, "the Note's own audience decides, not its Create's");
  });

  it("falls back to the Create when the Note carries no addressing", async () => {
    const p1 = `${OUTBOX}?page=true`;
    const { posts } = await collect({
      [OUTBOX]: root(p1),
      [p1]: page(p1, [create("bare", "2026-09-01T10:00:00Z", { to: [] })]),
    });
    assert.equal(posts.length, 1);
  });

  it("drops a followers-only Announce too", async () => {
    const p1 = `${OUTBOX}?page=true`;
    const { posts } = await collect({
      [OUTBOX]: root(p1),
      [p1]: page(p1, [
        {
          id: `${ORIGIN}/act/b`,
          type: "Announce",
          actor: ACTOR,
          published: "2026-09-01T10:00:00Z",
          to: [`${ACTOR}/followers`],
          object: "https://elsewhere.test/n/1",
        },
      ]),
    });
    assert.equal(posts.length, 0);
  });
});

describe("referenced objects (Fedify-style servers such as Hackers' Pub)", () => {
  const noteAt = (id: string, published: string) => ({
    "@context": AS,
    ...note(id, published),
  });

  it("fetches a same-origin referenced Note and counts it", async () => {
    const p1 = OUTBOX + "?page=true";
    const ref = ORIGIN + "/notes/r1";
    const { posts, calls, progress } = await collect({
      [OUTBOX]: root(p1),
      [p1]: page(p1, [{ ...create("r1", "2026-09-01T10:00:00Z"), object: ref }]),
      [ref]: noteAt("r1", "2026-09-01T10:00:00Z"),
    });
    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.kind, "post");
    assert.ok(calls.includes(ref), "the reference must be fetched");
    assert.equal(progress.dereferenced, 1);
    assert.equal(progress.partial, false);
  });

  it("never fetches a reference on another origin", async () => {
    const p1 = OUTBOX + "?page=true";
    const evil = "https://evil.test/notes/x";
    const { posts, calls } = await collect({
      [OUTBOX]: root(p1),
      [p1]: page(p1, [{ ...create("x", "2026-09-01T10:00:00Z"), object: evil }]),
      [evil]: noteAt("x", "2026-09-01T10:00:00Z"),
    });
    assert.equal(posts.length, 0);
    assert.equal(
      calls.includes(evil),
      false,
      "a foreign reference is a request we do not make",
    );
  });

  it("stops dereferencing at the budget and marks the result partial", async () => {
    const p1 = OUTBOX + "?page=true";
    const docs: Record<string, unknown> = { [OUTBOX]: root(p1) };
    const items = [];
    for (let index = 0; index < MAX_DEREFERENCES + 5; index++) {
      const ref = ORIGIN + "/notes/b" + index;
      items.push({ ...create("b" + index, "2026-09-01T10:00:00Z"), object: ref });
      docs[ref] = noteAt("b" + index, "2026-09-01T10:00:00Z");
    }
    docs[p1] = page(p1, items);
    const { posts, progress, calls } = await collect(docs);
    assert.equal(posts.length, MAX_DEREFERENCES);
    assert.equal(progress.dereferenced, MAX_DEREFERENCES);
    assert.equal(progress.partial, true, "skipped references must be disclosed");
    assert.equal(calls.filter((call) => call.includes("/notes/b")).length, MAX_DEREFERENCES);
  });
});

describe("pages without an id (Plume)", () => {
  it("keeps the embedded activities instead of refetching them", async () => {
    // Plume pages have no `id` and use `items`, so Fedify's embedded check drops every
    // activity; Plume 404s the activity ids, so refetching cannot rescue them.
    const p1 = OUTBOX + "?page=1";
    const a1 = { ...create("p1", "2026-09-01T10:00:00Z"), id: ORIGIN + "/act/p1" };
    const a2 = { ...create("p2", "2026-09-02T10:00:00Z"), id: ORIGIN + "/act/p2" };
    const { posts, calls, progress } = await collect({
      [OUTBOX]: root(p1),
      [p1]: { "@context": AS, type: "OrderedCollectionPage", partOf: OUTBOX, items: [a1, a2] },
    });
    assert.equal(posts.length, 2);
    assert.equal(progress.dereferenced, 0, "nothing is fetched twice");
    assert.ok(!calls.includes(a1.id) && !calls.includes(a2.id));
    assert.equal(progress.partial, false);
  });
});

describe("mention counting", () => {
  it("keeps every mention of a large group reply", async () => {
    // Mastodon group threads routinely carry 40-50 mentions. A per-post cap of
    // 30 dropped 29 distinct accounts from a real user's year.
    const p1 = OUTBOX + "?page=true";
    const tag = Array.from({ length: 50 }, (_value, index) => ({
      type: "Mention",
      href: "https://y.test/users/u" + index,
      name: "@u" + index + "@y.test",
    }));
    const { posts } = await collect({
      [OUTBOX]: root(p1),
      [p1]: page(p1, [create("group", "2026-09-01T10:00:00Z", { tag })]),
    });
    assert.equal(posts[0]?.mentions.length, 50);
  });
});

describe("content warnings", () => {
  it("reads summary as a CW on a Note but as the excerpt on an Article", async () => {
    const p1 = `${OUTBOX}?page=true`;
    const { posts } = await collect({
      [OUTBOX]: root(p1),
      [p1]: page(p1, [
        create("toot", "2026-09-02T10:00:00Z", { summary: "spoilers" }),
        create("blog", "2026-09-01T10:00:00Z", {
          type: "Article",
          summary: "What this is about",
        }),
      ]),
    });
    assert.deepEqual(
      posts.map((post) => post.hasCw),
      [true, false],
    );
  });
});

describe("media counting", () => {
  it("does not count a link preview as media", async () => {
    // Mastodon lists link previews under `attachment` as a bare Link. Counting them doubled
    // "posts with media" and dropped the alt-text rate from 96% to 46%.
    const p1 = OUTBOX + "?page=true";
    const preview = {
      type: "Link",
      href: "https://example.test/article",
      name: "A headline",
      mediaType: "text/html",
    };
    const image = { type: "Image", url: "https://x.test/i.png", name: "a described picture" };
    const { posts } = await collect({
      [OUTBOX]: root(p1),
      [p1]: page(p1, [
        create("linkonly", "2026-09-01T10:00:00Z", { attachment: [preview] }),
        create("realmedia", "2026-09-02T10:00:00Z", { attachment: [image] }),
        create("both", "2026-09-03T10:00:00Z", { attachment: [preview, image] }),
      ]),
    });
    const byKind = posts.map((post) => [post.attachments, post.attachmentsWithAlt]);
    assert.deepEqual(
      byKind,
      [
        [0, 0],
        [1, 1],
        [1, 1],
      ],
      "a Link attachment must never count as media, and must not dilute the alt rate",
    );
  });

  it("keeps full alt-text credit for a post over the attachment cap", async () => {
    const p1 = `${OUTBOX}?page=true`;
    const images = Array.from({ length: 25 }, (_value, index) => ({
      type: "Image",
      url: `https://x.test/${index}.png`,
      name: `picture ${index}`,
    }));
    const { posts } = await collect({
      [OUTBOX]: root(p1),
      [p1]: page(p1, [create("many", "2026-09-01T10:00:00Z", { attachment: images })]),
    });
    assert.deepEqual(
      posts.map((post) => [post.attachments, post.attachmentsWithAlt]),
      [[20, 20]],
      "25 described images must count as fully described, not 20 of 21",
    );
  });
});

describe("request amplification", () => {
  it("never fetches the object of a boost", async () => {
    // A page of 20 bare references must cost zero extra requests, or one
    // hostile page turns into twenty.
    const p1 = `${OUTBOX}?page=true`;
    const items = Array.from({ length: 20 }, (_value, index) => ({
      id: `${ORIGIN}/act/b${index}`,
      type: "Announce",
      actor: ACTOR,
      published: "2026-09-01T10:00:00Z",
      to: [PUBLIC],
      object: `https://elsewhere.test/notes/${index}`,
    }));
    const { posts, calls } = await collect({ [OUTBOX]: root(p1), [p1]: page(p1, items) });
    assert.equal(posts.length, 20);
    assert.deepEqual(calls, [OUTBOX, p1], "exactly two fetches: the root and one page");
  });
});

describe("authorized fetch", () => {
  it("retries signed after a 401 and only then", async () => {
    const p1 = `${OUTBOX}?page=true`;
    const signed = loaderOf({
      [OUTBOX]: root(p1),
      [p1]: page(p1, [create("1", "2026-09-01T10:00:00Z")]),
    });
    const unsigned: DocumentLoader = async () => {
      const error = new Error("401") as Error & { response: Response };
      error.response = new Response("", { status: 401 });
      throw error;
    };
    const { outbox, loader } = await openOutbox(actor(), { unsigned, signed: signed.load });
    assert.ok(
      await routesThrough(loader, signed),
      "the signed loader must be used for the rest of the walk",
    );
    assert.ok(outbox);
  });

  it("retries signed when the unsigned fetch resolves to null", async () => {
    // Fedify's accessors return null on a failed fetch as often as they throw; treating
    // null as "no outbox" reported authorized-fetch instances as having no posts.
    const p1 = OUTBOX + "?page=true";
    const signed = loaderOf({
      [OUTBOX]: root(p1),
      [p1]: page(p1, [create("1", "2026-09-01T10:00:00Z")]),
    });
    const nullish = new Person({
      id: new URL(ACTOR),
      preferredUsername: "a",
      outbox: new URL(OUTBOX),
    });
    const unsigned: DocumentLoader = async () => ({
      contextUrl: null,
      documentUrl: OUTBOX,
      document: { "@context": AS, id: OUTBOX, type: "Note" },
    });
    const { loader } = await openOutbox(nullish, { unsigned, signed: signed.load });
    assert.ok(
      await routesThrough(loader, signed),
      "a null unsigned result must fall through to signed",
    );
  });

  it("does not sign for a 404", async () => {
    const signed = loaderOf({});
    const unsigned: DocumentLoader = async () => {
      const error = new Error("404") as Error & { response: Response };
      error.response = new Response("", { status: 404 });
      throw error;
    };
    await assert.rejects(
      () => openOutbox(actor(), { unsigned, signed: signed.load }),
      (error: unknown) => error instanceof OutboxError && error.kind === "outboxGone",
    );
    assert.deepEqual(signed.calls, [], "a missing outbox is not an authorization problem");
  });
});

describe("account header", () => {
  const webfinger = async () => "@a@example.social";
  const noHandle = async (): Promise<string> => {
    throw new TypeError("no handle");
  };

  it("takes the handle from WebFinger, where the domain may differ from the host", async () => {
    // Mastodon's WEB_DOMAIN/LOCAL_DOMAIN split: the actor lives on x.test, the
    // account is @a@example.social. Only WebFinger knows.
    const { load, calls } = loaderOf({});
    const account = await readAccount(actor(), load, webfinger);
    assert.equal(account.handle, "a@example.social");
    assert.deepEqual(calls, [], "the followers collection is not fetched when there is none");
  });

  it("falls back to preferredUsername@host when no handle can be resolved", async () => {
    const { load } = loaderOf({});
    const account = await readAccount(actor(), load, noHandle);
    assert.equal(account.handle, "a@x.test");
  });

  it("reports a refused follower collection as null, never zero", async () => {
    const { load, calls } = loaderOf({});
    const withFollowers = new Person({
      id: new URL(ACTOR),
      preferredUsername: "a",
      outbox: new URL(OUTBOX),
      followers: new URL(`${ACTOR}/followers`),
    });
    const account = await readAccount(withFollowers, load, webfinger);
    assert.equal(account.followers, null);
    assert.deepEqual(calls, [`${ACTOR}/followers`]);
  });

  it("never requests a follower collection on a different origin", async () => {
    const { load, calls } = loaderOf({
      "https://evil.test/followers": { "@context": AS, type: "Collection", totalItems: 5 },
    });
    const offOrigin = new Person({
      id: new URL(ACTOR),
      preferredUsername: "a",
      outbox: new URL(OUTBOX),
      followers: new URL("https://evil.test/followers"),
    });
    const account = await readAccount(offOrigin, load, webfinger);
    assert.equal(account.followers, null);
    assert.deepEqual(calls, []);
  });

  it("keeps the header drawable whatever WebFinger returns", async () => {
    const { load } = loaderOf({});
    const RLO = String.fromCharCode(0x202e);
    const account = await readAccount(actor(), load, async () => `@a${RLO}@evil.test`);
    assert.equal(account.handle, "a@evil.test");
  });
});

describe("text handling", () => {
  const NUL = String.fromCharCode(0);
  const RLO = String.fromCharCode(0x202e);
  const ZWJ = String.fromCharCode(0x200d);

  it("strips control characters and bidi overrides but keeps emoji joiners", () => {
    assert.equal(clean(`a${NUL}b`), "ab");
    assert.equal(clean(`a${RLO}b`), "ab");
    // The joiner holds the pieces of a multi-person emoji together; removing it
    // would shatter the emoji and break Arabic and Devanagari shaping too.
    assert.ok(clean(`\u{1F468}${ZWJ}\u{1F469}`).includes(ZWJ));
  });

  it("slices before repairing surrogates, never after", () => {
    // Slicing can halve an emoji. Repairing after the slice yields a well-formed string;
    // the reverse leaves a lone surrogate that JSON, SQLite and SVG choke on.
    const value = `${"a".repeat(9)}\u{1F600}`;
    const out = clean(value, 10);
    assert.equal(out.isWellFormed(), true, "no lone surrogate may survive");
  });

  it("turns markup into readable text", () => {
    assert.equal(htmlToText("<p>a</p><p>b</p>"), "a\n\nb");
    assert.equal(htmlToText("a<br>b"), "a\nb");
    assert.equal(htmlToText("<script>evil()</script>ok"), "ok");
    assert.equal(htmlToText("&amp;lt;"), "&lt;");
  });
});

describe("timestamp sanity", () => {
  const at = (iso: string): Post => ({
    createdAt: new Date(iso),
    kind: "post",
    tags: [],
    mentions: [],
    attachments: 0,
    attachmentsWithAlt: 0,
    hasCw: false,
    chars: 0,
    words: 0,
    likes: null,
    shares: null,
  });

  it("rejects the far future and the far past", () => {
    assert.equal(plausible(at("2026-09-01T00:00:00Z"), NOW), true);
    assert.equal(plausible(at("2300-01-01T00:00:00Z"), NOW), false);
    assert.equal(plausible(at("1970-01-01T00:00:00Z"), NOW), false);
  });
});
